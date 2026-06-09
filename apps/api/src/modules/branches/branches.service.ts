import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import { BranchResponseDto, CreateBranchDto, UpdateBranchDto } from './branches.dto';

const TTL = 300;
const cacheKey = (orgId: string) => `ref:branches:${orgId}`;

@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(orgId: string, showDeleted = false): Promise<BranchResponseDto[]> {
    if (!showDeleted) {
      const cached = await this.cache.get<BranchResponseDto[]>(cacheKey(orgId));
      if (cached) return cached;
    }

    const items = await this.prisma.garageBranch.findMany({
      where: { orgId, ...(!showDeleted ? { deletedAt: null } : {}) },
      orderBy: { name: 'asc' },
      take: 500,
    });
    const result = items.map(item => this.toDto(item));
    if (!showDeleted) await this.cache.set(cacheKey(orgId), result, TTL);
    return result;
  }

  async findOne(orgId: string, id: string): Promise<BranchResponseDto> {
    const item = await this.prisma.garageBranch.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Філію не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateBranchDto): Promise<BranchResponseDto> {
    const item = await this.prisma.garageBranch.create({
      data: { ...dto, orgId },
    });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateBranchDto): Promise<BranchResponseDto> {
    // sto-optimize: narrow tenant guard — full row read для existence-check марний,
    // оскільки update нижче все одно повертає повний DTO. select:{id} зменшує wire payload.
    const existing = await this.prisma.garageBranch.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Філію не знайдено');
    const item = await this.prisma.garageBranch.update({ where: { id, orgId }, data: dto });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // sto-optimize: `findOne + update` 2-RTT → atomic `updateMany` with full
    // compound where (id+orgId+deletedAt:null). One statement, no race window,
    // -1 RTT per delete. Tenant ізоляція збережена через orgId у WHERE.
    const result = await this.prisma.garageBranch.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Філію не знайдено');
    await this.cache.del(cacheKey(orgId));
  }

  private toDto(item: {
    id: string;
    orgId: string;
    name: string;
    address: string;
    timezone: string;
    createdAt: Date;
    updatedAt: Date;
    deletedAt?: Date | null;
  }): BranchResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      name: item.name,
      address: item.address,
      timezone: item.timezone,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      deletedAt: item.deletedAt,
    };
  }
}
