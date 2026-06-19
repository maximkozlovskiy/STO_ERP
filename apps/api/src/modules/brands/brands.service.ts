import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import { BrandResponseDto, CreateBrandDto, UpdateBrandDto } from './brands.dto';

const TTL = 300;
const cacheKey = (orgId: string) => `ref:brands:${orgId}`;

const SYNONYMS_INCLUDE = { synonyms: { where: { deletedAt: null }, select: { synonym: true } } };

@Injectable()
export class BrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(
    orgId: string,
    showDeleted = false,
  ): Promise<{ items: BrandResponseDto[]; total: number }> {
    if (!showDeleted) {
      const cached = await this.cache.get<{ items: BrandResponseDto[]; total: number }>(
        cacheKey(orgId),
      );
      if (cached) return cached;
    }

    const where = { orgId, ...(showDeleted ? {} : { deletedAt: null }) };
    const [items, total] = await Promise.all([
      this.prisma.brand.findMany({
        where,
        include: SYNONYMS_INCLUDE,
        // Bug #306: explicit `nulls: 'first'` для deletedAt — Postgres за замовчуванням
        // ставить NULL у кінець ASC → активні (deletedAt=NULL) йшли б ПОСЛЕ видалених
        // у списку showDeleted=true. Парний паттерн до units.service.ts (Bug #296).
        orderBy: [{ deletedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
        take: 1000,
      }),
      this.prisma.brand.count({ where }),
    ]);
    const result = { items: items.map(item => this.toDto(item)), total };
    if (!showDeleted) await this.cache.set(cacheKey(orgId), result, TTL);
    return result;
  }

  async restore(orgId: string, id: string): Promise<BrandResponseDto> {
    // Defense-in-depth: atomic updateMany with full compound where (sto-review pattern
    // 2026-05-30). One statement asserts (id, orgId, currently-deleted) — eliminates
    // the race window between separate findFirst + update().
    const result = await this.prisma.brand.updateMany({
      where: { id, orgId, NOT: { deletedAt: null } },
      data: { deletedAt: null },
    });
    if (result.count === 0) throw new NotFoundException('Видалений бренд не знайдено');
    const item = await this.prisma.brand.findFirstOrThrow({
      where: { id, orgId },
      include: SYNONYMS_INCLUDE,
    });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async findOne(orgId: string, id: string): Promise<BrandResponseDto> {
    const item = await this.prisma.brand.findFirst({
      where: { id, orgId, deletedAt: null },
      include: SYNONYMS_INCLUDE,
    });
    if (!item) throw new NotFoundException('Бренд не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateBrandDto): Promise<BrandResponseDto> {
    const synonyms = this.cleanSynonyms(dto.synonyms);

    // sto-optimize: only id + deletedAt consumed (resurrect-vs-conflict branch).
    const anyExisting = await this.prisma.brand.findFirst({
      where: { orgId, name: dto.name },
      select: { id: true, deletedAt: true },
    });
    if (anyExisting) {
      if (!anyExisting.deletedAt) throw new ConflictException('Бренд з такою назвою вже існує');
      const restored = await this.prisma.brand.update({
        where: { id: anyExisting.id },
        data: { name: dto.name, deletedAt: null },
        include: SYNONYMS_INCLUDE,
      });
      await this.syncSynonyms(orgId, anyExisting.id, synonyms);
      const item = await this.prisma.brand.findFirstOrThrow({
        where: { id: anyExisting.id },
        include: SYNONYMS_INCLUDE,
      });
      await this.cache.del(cacheKey(orgId));
      return this.toDto(item);
    }

    const item = await this.prisma.brand.create({
      data: {
        name: dto.name,
        orgId,
        synonyms: synonyms.length
          ? {
              createMany: {
                data: synonyms.map(s => ({ orgId, synonym: s })),
                skipDuplicates: true,
              },
            }
          : undefined,
      },
      include: SYNONYMS_INCLUDE,
    });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateBrandDto): Promise<BrandResponseDto> {
    const synonyms = this.cleanSynonyms(dto.synonyms);

    // Perf: tenant guard + duplicate-name check паралелизуються — обидва тенант-ізольовані,
    // duplicate-check читає по dto.name (не по existing) → немає залежності.
    const [existing, duplicate] = await Promise.all([
      this.prisma.brand.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.brand.findFirst({
        where: { orgId, name: dto.name, NOT: { id }, deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (!existing) throw new NotFoundException('Бренд не знайдено');
    if (duplicate) throw new ConflictException('Бренд з такою назвою вже існує');

    await this.prisma.brand.update({ where: { id, orgId }, data: { name: dto.name } });
    await this.syncSynonyms(orgId, id, synonyms);

    const item = await this.prisma.brand.findFirstOrThrow({
      where: { id, orgId },
      include: SYNONYMS_INCLUDE,
    });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // sto-optimize (2026-05-31 pattern): `findOne + update` 2-RTT → atomic `updateMany`
    // with full compound where (id+orgId+deletedAt:null). One statement, no race window,
    // -1 RTT per delete. Тенант-ізоляція збережена через orgId у WHERE.
    const result = await this.prisma.brand.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Бренд не знайдено');
    // Soft-delete synonyms too
    await this.prisma.brandSynonym.updateMany({
      where: { brandId: id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await this.cache.del(cacheKey(orgId));
  }

  // Diff synonyms: soft-delete removed, create new
  private async syncSynonyms(orgId: string, brandId: string, incoming: string[]): Promise<void> {
    const existing = await this.prisma.brandSynonym.findMany({
      where: { brandId, orgId, deletedAt: null },
      select: { id: true, synonym: true },
    });
    const existingSet = new Set(existing.map(s => s.synonym));
    const incomingSet = new Set(incoming);

    const toRemove = existing.filter(s => !incomingSet.has(s.synonym)).map(s => s.id);
    const toAdd = incoming.filter(s => !existingSet.has(s));

    await Promise.all([
      toRemove.length
        ? this.prisma.brandSynonym.updateMany({
            where: { id: { in: toRemove } },
            data: { deletedAt: new Date() },
          })
        : Promise.resolve(),
      toAdd.length
        ? this.prisma.brandSynonym.createMany({
            data: toAdd.map(s => ({ orgId, brandId, synonym: s })),
            skipDuplicates: true,
          })
        : Promise.resolve(),
    ]);
  }

  private cleanSynonyms(raw?: string[]): string[] {
    if (!raw) return [];
    return [...new Set(raw.map(s => s.trim()).filter(s => s.length > 0))];
  }

  private toDto(item: {
    id: string;
    orgId: string;
    name: string;
    deletedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
    synonyms?: { synonym: string }[];
  }): BrandResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      name: item.name,
      synonyms: (item.synonyms ?? []).map(s => s.synonym),
      deletedAt: item.deletedAt ?? null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
