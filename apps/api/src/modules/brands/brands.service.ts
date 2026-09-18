import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Brand } from '@prisma/client';
import { translateError } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { getLocale } from '../../common/tenant/tenant-context';
import { normalizeArticle } from '../../common/utils/normalize-article';
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
        // Explicit `nulls: 'first'` для deletedAt — Postgres за замовчуванням ставить NULL
        // у кінець ASC → активні (deletedAt=NULL) йшли б після видалених у showDeleted=true.
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
    // MD-C1 parity guard: `@@unique([orgId, name])` НЕ має partial `WHERE deletedAt
    // IS NULL`, тож активний бренд із такою ж назвою зробив би restore() джерелом
    // P2002 → 500 замість охайного 409. Через API це майже недосяжно (create()
    // воскрешає soft-deleted рядок замість створення дубля), але захищає від
    // ручних SQL/сідів і тримає паритет із units.restore().
    const deleted = await this.prisma.brand.findFirst({
      where: { id, orgId, NOT: { deletedAt: null } },
      select: { name: true },
    });
    if (!deleted)
      throw new NotFoundException(translateError('err.brand.deletedNotFound', getLocale()));
    const activeDuplicate = await this.prisma.brand.findFirst({
      where: { orgId, name: deleted.name, deletedAt: null, NOT: { id } },
      select: { id: true },
    });
    if (activeDuplicate)
      throw new ConflictException(translateError('err.brand.activeNameExists', getLocale()));
    // Defense-in-depth: atomic updateMany with full compound where (sto-review pattern
    // 2026-05-30). One statement asserts (id, orgId, currently-deleted) — eliminates
    // the race window between separate findFirst + update().
    const result = await this.prisma.brand.updateMany({
      where: { id, orgId, NOT: { deletedAt: null } },
      data: { deletedAt: null },
    });
    if (result.count === 0)
      throw new NotFoundException(translateError('err.brand.deletedNotFound', getLocale()));
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
    if (!item) throw new NotFoundException(translateError('err.brand.notFound', getLocale()));
    return this.toDto(item);
  }

  /**
   * Резолвить бренд за сирою назвою АБО синонімом (для Excel-імпорту товарів).
   * norm = normalizeArticle(raw). Пріоритет:
   *  1) Brand, у якого normalizeArticle(name) === norm (порівняння у JS — список брендів org малий);
   *  2) BrandSynonym.normalizedSynonym === norm (findFirst orgId+deletedAt:null).
   * Повертає Brand або null. Порожній/некоректний raw (norm === '') → null (не матчимо все підряд).
   */
  async resolveByNameOrSynonym(
    orgId: string,
    raw: string | null | undefined,
  ): Promise<Brand | null> {
    const norm = normalizeArticle(raw);
    if (!norm) return null;

    // Список активних брендів org (обмежений take: 1000, як у findAll) — нормалізуємо name у JS,
    // бо normalizeArticle не виражається у SQL. Для типового СТО брендів десятки-сотні.
    const brands = await this.prisma.brand.findMany({
      where: { orgId, deletedAt: null },
      take: 1000,
    });
    const byName = brands.find(b => normalizeArticle(b.name) === norm);
    if (byName) return byName;

    const synonym = await this.prisma.brandSynonym.findFirst({
      where: { orgId, normalizedSynonym: norm, deletedAt: null },
      select: { brandId: true },
    });
    if (!synonym) return null;
    return this.prisma.brand.findFirst({
      where: { id: synonym.brandId, orgId, deletedAt: null },
    });
  }

  async create(orgId: string, dto: CreateBrandDto): Promise<BrandResponseDto> {
    const synonyms = this.cleanSynonyms(dto.synonyms);

    // sto-optimize: only id + deletedAt consumed (resurrect-vs-conflict branch).
    const anyExisting = await this.prisma.brand.findFirst({
      where: { orgId, name: dto.name },
      select: { id: true, deletedAt: true },
    });
    if (anyExisting) {
      if (!anyExisting.deletedAt)
        throw new ConflictException(translateError('err.brand.nameExists', getLocale()));
      // Resurrect soft-deleted brand. Include is omitted: we re-fetch after
      // syncSynonyms() below, so the returned row would be stale anyway.
      await this.prisma.brand.update({
        where: { id: anyExisting.id, orgId },
        data: { name: dto.name, deletedAt: null },
      });
      await this.syncSynonyms(orgId, anyExisting.id, synonyms);
      const item = await this.prisma.brand.findFirstOrThrow({
        where: { id: anyExisting.id, orgId },
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
                data: synonyms.map(s => ({
                  orgId,
                  synonym: s,
                  normalizedSynonym: normalizeArticle(s),
                })),
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
    if (!existing) throw new NotFoundException(translateError('err.brand.notFound', getLocale()));
    if (duplicate) throw new ConflictException(translateError('err.brand.nameExists', getLocale()));

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
    if (result.count === 0)
      throw new NotFoundException(translateError('err.brand.notFound', getLocale()));
    // Soft-delete synonyms too
    await this.prisma.brandSynonym.updateMany({
      where: { brandId: id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await this.cache.del(cacheKey(orgId));
  }

  // Diff synonyms: soft-delete removed, create new (resurrection-aware).
  //
  // §5.2 — BrandSynonym has @@unique([orgId, synonym]) WITHOUT deletedAt.
  // Naive `createMany({ skipDuplicates: true })` silently ignores synonyms whose
  // row already exists in `deletedAt != null` state (the unique slot is still
  // occupied), so re-adding "OEM" after removing it would NOT reappear.
  // We split the incoming list into (a) resurrect — flip deletedAt=null AND
  // re-bind to this brandId for existing soft-deleted rows (org-scoped because
  // the unique is org-scoped), (b) create — only truly new synonyms.
  private async syncSynonyms(orgId: string, brandId: string, incoming: string[]): Promise<void> {
    // Read active rows for THIS brand + any soft-deleted rows ACROSS the org
    // (unique is per-org, so resurrection must consider other brands' tombstones).
    const [activeOfBrand, deletedInOrg] = await Promise.all([
      this.prisma.brandSynonym.findMany({
        where: { brandId, orgId, deletedAt: null },
        select: { id: true, synonym: true },
      }),
      incoming.length
        ? this.prisma.brandSynonym.findMany({
            where: { orgId, synonym: { in: incoming }, deletedAt: { not: null } },
            select: { id: true, synonym: true },
          })
        : Promise.resolve([] as { id: string; synonym: string }[]),
    ]);
    const activeBySyn = new Map(activeOfBrand.map(s => [s.synonym, s.id]));
    const deletedBySyn = new Map(deletedInOrg.map(s => [s.synonym, s.id]));
    const incomingSet = new Set(incoming);

    // Active rows of THIS brand that are no longer in incoming → soft-delete.
    const toRemove = [...activeBySyn.entries()]
      .filter(([syn]) => !incomingSet.has(syn))
      .map(([, id]) => id);
    // Incoming entries not yet active for this brand.
    const notActive = incoming.filter(s => !activeBySyn.has(s));
    // Among those, ones whose soft-deleted row exists somewhere in the org → resurrect+rebind.
    const toResurrect = notActive
      .filter(s => deletedBySyn.has(s))
      .map(s => ({ id: deletedBySyn.get(s)!, synonym: s }));
    // The rest → truly new rows.
    const toCreate = notActive.filter(s => !deletedBySyn.has(s));

    await Promise.all([
      toRemove.length
        ? this.prisma.brandSynonym.updateMany({
            where: { id: { in: toRemove }, orgId },
            data: { deletedAt: new Date() },
          })
        : Promise.resolve(),
      // Resurrect: воскрешаємо по одному updateMany на synonym, щоб заповнити normalizedSynonym
      // (старі tombstone-рядки могли мати null) — набір малий (≤20 синонімів на бренд).
      ...toResurrect.map(({ id, synonym }) =>
        this.prisma.brandSynonym.updateMany({
          where: { id, orgId },
          data: { deletedAt: null, brandId, normalizedSynonym: normalizeArticle(synonym) },
        }),
      ),
      toCreate.length
        ? this.prisma.brandSynonym.createMany({
            data: toCreate.map(s => ({
              orgId,
              brandId,
              synonym: s,
              normalizedSynonym: normalizeArticle(s),
            })),
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
      deletedAt:
        item.deletedAt instanceof Date ? item.deletedAt.toISOString() : (item.deletedAt ?? null),
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
      updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
    };
  }
}
