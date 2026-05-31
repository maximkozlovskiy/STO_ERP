import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import { BrandResponseDto, CreateBrandDto, UpdateBrandDto } from './brands.dto';

const TTL = 300;
const cacheKey = (orgId: string) => `ref:brands:${orgId}`;

@Injectable()
export class BrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(orgId: string): Promise<{ items: BrandResponseDto[]; total: number }> {
    const cached = await this.cache.get<{ items: BrandResponseDto[]; total: number }>(
      cacheKey(orgId),
    );
    if (cached) return cached;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.brand.findMany({
        where: { orgId, deletedAt: null },
        orderBy: { name: 'asc' },
        take: 1000,
      }),
      this.prisma.brand.count({ where: { orgId, deletedAt: null } }),
    ]);
    const result = { items: items.map(item => this.toDto(item)), total };
    await this.cache.set(cacheKey(orgId), result, TTL);
    return result;
  }

  async findOne(orgId: string, id: string): Promise<BrandResponseDto> {
    const item = await this.prisma.brand.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!item) throw new NotFoundException('Бренд не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateBrandDto): Promise<BrandResponseDto> {
    const anyExisting = await this.prisma.brand.findFirst({ where: { orgId, name: dto.name } });
    if (anyExisting) {
      if (!anyExisting.deletedAt) throw new ConflictException('Бренд з такою назвою вже існує');
      const restored = await this.prisma.brand.update({
        where: { id: anyExisting.id },
        data: { ...dto, deletedAt: null },
      });
      await this.cache.del(cacheKey(orgId));
      return this.toDto(restored);
    }
    const item = await this.prisma.brand.create({ data: { ...dto, orgId } });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateBrandDto): Promise<BrandResponseDto> {
    // Perf: tenant guard + duplicate-name check паралелизуються — обидва тенант-ізольовані,
    // duplicate-check читає по dto.name (не по existing) → немає залежності.
    const [existing, duplicate] = await Promise.all([
      this.prisma.brand.findFirst({ where: { id, orgId, deletedAt: null } }),
      this.prisma.brand.findFirst({
        where: { orgId, name: dto.name, NOT: { id }, deletedAt: null },
      }),
    ]);
    if (!existing) throw new NotFoundException('Бренд не знайдено');
    if (duplicate) throw new ConflictException('Бренд з такою назвою вже існує');
    const item = await this.prisma.brand.update({ where: { id, orgId }, data: dto });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const existing = await this.prisma.brand.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Бренд не знайдено');
    await this.prisma.brand.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
    await this.cache.del(cacheKey(orgId));
  }

  private toDto(item: {
    id: string;
    orgId: string;
    name: string;
    createdAt: Date;
    updatedAt: Date;
  }): BrandResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      name: item.name,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
