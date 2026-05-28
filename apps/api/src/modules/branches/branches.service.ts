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

  async findAll(orgId: string): Promise<BranchResponseDto[]> {
    const cached = await this.cache.get<BranchResponseDto[]>(cacheKey(orgId));
    if (cached) return cached;

    const items = await this.prisma.garageBranch.findMany({
      where: { orgId, deletedAt: null },
      orderBy: { name: 'asc' },
      take: 100,
    });
    const result = items.map(item => this.toDto(item));
    await this.cache.set(cacheKey(orgId), result, TTL);
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
    const existing = await this.prisma.garageBranch.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Філію не знайдено');
    const item = await this.prisma.garageBranch.update({ where: { id, orgId }, data: dto });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const existing = await this.prisma.garageBranch.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Філію не знайдено');
    await this.prisma.garageBranch.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
    await this.cache.del(cacheKey(orgId));
  }

  private toDto(item: {
    id: string; orgId: string; name: string; address: string;
    timezone: string; createdAt: Date; updatedAt: Date;
  }): BranchResponseDto {
    return {
      id: item.id, orgId: item.orgId, name: item.name,
      address: item.address, timezone: item.timezone,
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    };
  }
}
