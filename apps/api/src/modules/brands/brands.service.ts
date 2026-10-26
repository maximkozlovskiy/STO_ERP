import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Brand, Prisma } from '@prisma/client';
import { translateError } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { getLocale } from '../../common/tenant/tenant-context';
import { normalizeArticle } from '../../common/utils/normalize-article';
import { CacheService } from '../../redis/cache.service';
import { BrandResponseDto, CreateBrandDto, UpdateBrandDto } from './brands.dto';

const TTL = 300;
const cacheKey = (orgId: string) => `ref:brands:${orgId}`;

/**
 * BR-GOOD-007: один запис написання — один бренд. Ключ порівняння синонімів і назв:
 * без пробілів по краях і без урахування регістру («Bosch» і «BOSCH» — те саме написання).
 */
const synonymKey = (s: string): string => s.trim().toLocaleLowerCase('uk');

/**
 * Prisma `equals` + `mode: 'insensitive'` іде в Postgres як `ILIKE` БЕЗ екранування: `_` і `%`
 * у значенні працюють як шаблон. Синонім «A_C» «збігався» з чужим «AXC», а «%» — з будь-яким
 * (перевірено через API 2026-10-12). Екрануємо самі; остаточне рішення — за `synonymKey` у JS.
 */
const insensitive = (value: string) => ({
  equals: value.replace(/[\\%_]/g, '\\$&'),
  mode: 'insensitive' as const,
});

/** Стеля для вибірки кандидатів: до 21 написання в запиті, збігів на кожне — одиниці. */
const CANDIDATES = 200;

const SYNONYMS_INCLUDE = { synonyms: { where: { deletedAt: null }, select: { synonym: true } } };

type Db = Prisma.TransactionClient;

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
    await this.underWritingsLock(orgId, async tx => {
      // MD-C1 parity guard: `@@unique([orgId, name])` НЕ має partial `WHERE deletedAt
      // IS NULL`, тож активний бренд із такою ж назвою зробив би restore() джерелом
      // P2002 → 500 замість охайного 409. Через API це майже недосяжно (create()
      // воскрешає soft-deleted рядок замість створення дубля), але захищає від
      // ручних SQL/сідів і тримає паритет із units.restore().
      const deleted = await tx.brand.findFirst({
        where: { id, orgId, NOT: { deletedAt: null } },
        select: { name: true, synonyms: SYNONYMS_INCLUDE.synonyms },
      });
      if (!deleted)
        throw new NotFoundException(translateError('err.brand.deletedNotFound', getLocale()));
      const activeDuplicate = await tx.brand.findFirst({
        where: { orgId, name: deleted.name, deletedAt: null, NOT: { id } },
        select: { id: true },
      });
      if (activeDuplicate)
        throw new ConflictException(translateError('err.brand.activeNameExists', getLocale()));
      // BR-GOOD-007: поки бренд був видалений, його назву могли додати синонімом іншому бренду.
      // Синоніми remove() знімає разом із брендом, тож зазвичай їх тут немає; якщо ж лишились
      // активними (старі дані) — вони повертаються разом із брендом і теж мають бути вільні.
      await this.assertWritingsFree(
        tx,
        orgId,
        id,
        deleted.name,
        (deleted.synonyms ?? []).map(s => s.synonym),
      );
      // Defense-in-depth: atomic updateMany with full compound where (sto-review pattern
      // 2026-05-30). One statement asserts (id, orgId, currently-deleted) — eliminates
      // the race window between separate findFirst + update().
      const result = await tx.brand.updateMany({
        where: { id, orgId, NOT: { deletedAt: null } },
        data: { deletedAt: null },
      });
      if (result.count === 0)
        throw new NotFoundException(translateError('err.brand.deletedNotFound', getLocale()));
    });
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
   *  2) BrandSynonym.normalizedSynonym === norm (findFirst orgId+deletedAt:null);
   *  3) точне написання без урахування регістру (ключ BR-GOOD-007) — назва, потім синонім.
   * Повертає Brand або null. Порожній raw → null (не матчимо все підряд).
   *
   * Крок 3 потрібен кирилиці: `normalizeArticle` лишає тільки A-Z0-9, тож «БОШ» дає norm === ''
   * і кроки 1–2 його не бачать. Без кроку 3 імпорт ішов створювати бренд «БОШ» і падав цілим
   * файлом на 409 (назва зайнята / назва є синонімом іншого бренду, BR-GOOD-007).
   */
  async resolveByNameOrSynonym(
    orgId: string,
    raw: string | null | undefined,
  ): Promise<Brand | null> {
    const key = synonymKey(raw ?? '');
    if (!key) return null;
    const norm = normalizeArticle(raw);

    // Список активних брендів org (обмежений take: 1000, як у findAll) — нормалізуємо name у JS,
    // бо normalizeArticle не виражається у SQL. Для типового СТО брендів десятки-сотні.
    const brands = await this.prisma.brand.findMany({
      where: { orgId, deletedAt: null },
      take: 1000,
    });

    if (norm) {
      const byName = brands.find(b => normalizeArticle(b.name) === norm);
      if (byName) return byName;

      const synonym = await this.prisma.brandSynonym.findFirst({
        where: { orgId, normalizedSynonym: norm, deletedAt: null },
        select: { brandId: true },
      });
      if (synonym) {
        const bySynonym = await this.prisma.brand.findFirst({
          where: { id: synonym.brandId, orgId, deletedAt: null },
        });
        if (bySynonym) return bySynonym;
      }
    }

    const byWriting = brands.find(b => synonymKey(b.name) === key);
    if (byWriting) return byWriting;
    const candidates = await this.prisma.brandSynonym.findMany({
      where: {
        orgId,
        deletedAt: null,
        brand: { deletedAt: null },
        synonym: insensitive((raw ?? '').trim()),
      },
      select: { synonym: true, brandId: true },
      take: CANDIDATES,
    });
    const hit = candidates.find(c => synonymKey(c.synonym) === key);
    return hit ? (brands.find(b => b.id === hit.brandId) ?? null) : null;
  }

  async create(orgId: string, dto: CreateBrandDto): Promise<BrandResponseDto> {
    const name = dto.name.trim();
    const synonyms = this.cleanSynonyms(dto.synonyms, name);

    const id = await this.underWritingsLock(orgId, async tx => {
      // sto-optimize: only id + deletedAt consumed (resurrect-vs-conflict branch).
      const anyExisting = await tx.brand.findFirst({
        where: { orgId, name },
        select: { id: true, deletedAt: true },
      });
      if (anyExisting && !anyExisting.deletedAt)
        throw new ConflictException(translateError('err.brand.nameExists', getLocale()));
      await this.assertWritingsFree(tx, orgId, anyExisting?.id ?? null, name, synonyms);

      let brandId: string;
      if (anyExisting) {
        // Resurrect soft-deleted brand.
        await tx.brand.update({
          where: { id: anyExisting.id, orgId },
          data: { name, deletedAt: null },
        });
        brandId = anyExisting.id;
      } else {
        const created = await tx.brand.create({ data: { name, orgId }, select: { id: true } });
        brandId = created.id;
      }
      // Новий бренд теж іде через syncSynonyms, а не через вкладений `createMany skipDuplicates`:
      // той мовчки пропускав синонім, чий знятий рядок (tombstone) уже займає унікальний слот, —
      // бренд створювався «успішно», але без синоніма.
      await this.syncSynonyms(tx, orgId, brandId, synonyms);
      return brandId;
    });

    const item = await this.prisma.brand.findFirstOrThrow({
      where: { id, orgId },
      include: SYNONYMS_INCLUDE,
    });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateBrandDto): Promise<BrandResponseDto> {
    const name = dto.name.trim();
    const synonyms = this.cleanSynonyms(dto.synonyms, name);

    await this.underWritingsLock(orgId, async tx => {
      const existing = await tx.brand.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException(translateError('err.brand.notFound', getLocale()));
      const duplicate = await tx.brand.findFirst({
        where: { orgId, name, NOT: { id }, deletedAt: null },
        select: { id: true },
      });
      if (duplicate)
        throw new ConflictException(translateError('err.brand.nameExists', getLocale()));
      await this.assertWritingsFree(tx, orgId, id, name, synonyms);

      await tx.brand.update({ where: { id, orgId }, data: { name } });
      await this.syncSynonyms(tx, orgId, id, synonyms);
    });

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

  /**
   * BR-GOOD-007: перевірка написань і запис ідуть однією транзакцією під блокуванням організації.
   * Без цього два одночасні збереження різних брендів з тим самим новим синонімом обидва
   * проходили перевірку (кожне читало до запису іншого): однакове написання другий запис мовчки
   * пропускав на унікальному індексі, різний регістр («Bosch»/«bosch») — зберігалися обидва.
   * Блокування транзакційне — знімається разом із commit/rollback; помилка відкочує все.
   */
  private underWritingsLock<T>(orgId: string, work: (tx: Db) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`brands:${orgId}`}))`;
      return work(tx);
    });
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
  //
  // BR-GOOD-007: «вільний» рядок — це знятий синонім АБО синонім видаленого бренду (так само
  // рахує assertWritingsFree). Обидва переїжджають до поточного бренду: правило каже, що таке
  // написання нікому не належить, а унікальний слот інакше не дав би його створити.
  private async syncSynonyms(
    db: Db,
    orgId: string,
    brandId: string,
    incoming: string[],
  ): Promise<void> {
    // Read active rows for THIS brand + any free rows ACROSS the org
    // (unique is per-org, so resurrection must consider other brands' tombstones).
    // Вільні рядки — без урахування регістру: активний рядок видаленого бренду «BOSCH» займає слот
    // унікального індексу `lower(synonym)` серед активних, і новий «bosch» `createMany` мовчки
    // пропустив би (`skipDuplicates`). Такий рядок переїжджає з новим написанням.
    const [activeOfBrand, freeInOrg] = await Promise.all([
      db.brandSynonym.findMany({
        where: { brandId, orgId, deletedAt: null },
        select: { id: true, synonym: true },
      }),
      incoming.length
        ? db.brandSynonym.findMany({
            where: {
              orgId,
              AND: [
                { OR: incoming.map(s => ({ synonym: insensitive(s) })) },
                { OR: [{ deletedAt: { not: null } }, { brand: { deletedAt: { not: null } } }] },
              ],
            },
            select: { id: true, synonym: true, deletedAt: true },
          })
        : Promise.resolve([] as { id: string; synonym: string; deletedAt: Date | null }[]),
    ]);
    const activeBySyn = new Map(activeOfBrand.map(s => [s.synonym, s.id]));
    const incomingSet = new Set(incoming);

    // Active rows of THIS brand that are no longer in incoming → soft-delete.
    const toRemove = [...activeBySyn.entries()]
      .filter(([syn]) => !incomingSet.has(syn))
      .map(([, id]) => id);
    // Incoming entries not yet active for this brand.
    const notActive = incoming.filter(s => !activeBySyn.has(s));
    // Among those, ones whose free row exists somewhere in the org → resurrect+rebind. Один рядок
    // на ключ написання: точне написання, інакше активний рядок видаленого бренду (він займає слот
    // індексу), інакше знятий в іншому регістрі — його написання стає вхідним. Інший активний
    // рядок того самого ключа знімається (`toRemove`), інакше база не дасть відродити обраний.
    const toResurrect: { id: string; synonym: string; renamed: boolean }[] = [];
    for (const s of notActive) {
      const same = freeInOrg.filter(r => synonymKey(r.synonym) === synonymKey(s));
      const target =
        same.find(r => r.synonym === s) ?? same.find(r => r.deletedAt === null) ?? same[0];
      if (!target) continue;
      toResurrect.push({ id: target.id, synonym: s, renamed: target.synonym !== s });
      toRemove.push(...same.filter(r => r !== target && r.deletedAt === null).map(r => r.id));
    }
    const resurrected = new Set(toResurrect.map(r => r.synonym));
    // The rest → truly new rows.
    const toCreate = notActive.filter(s => !resurrected.has(s));

    // Зняття — ПЕРШИМ і окремо: зміна регістру в межах бренду («Bosch» → «BOSCH») — це зняття
    // старого рядка й новий рядок того самого ключа; поки старий активний, новий упирається в
    // `lower(synonym)`-індекс, а `createMany skipDuplicates` мовчки його пропускає.
    if (toRemove.length) {
      await db.brandSynonym.updateMany({
        where: { id: { in: toRemove }, orgId },
        data: { deletedAt: new Date() },
      });
    }
    await Promise.all([
      // Resurrect: воскрешаємо по одному updateMany на synonym, щоб заповнити normalizedSynonym
      // (старі tombstone-рядки могли мати null) — набір малий (≤20 синонімів на бренд).
      ...toResurrect.map(({ id, synonym, renamed }) =>
        db.brandSynonym.updateMany({
          where: { id, orgId },
          data: {
            deletedAt: null,
            brandId,
            normalizedSynonym: normalizeArticle(synonym),
            ...(renamed ? { synonym } : {}),
          },
        }),
      ),
      toCreate.length
        ? db.brandSynonym.createMany({
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

  /**
   * Обрізає, прибирає порожні й повтори (без урахування регістру — лишається перше написання)
   * і синонім, що збігається з назвою самого бренду: він нічого не додає до пошуку.
   */
  private cleanSynonyms(raw: string[] | undefined, ownName: string): string[] {
    if (!raw) return [];
    const seen = new Set<string>([synonymKey(ownName)]);
    const out: string[] = [];
    for (const item of raw) {
      const value = item.trim();
      const key = synonymKey(value);
      if (!value || seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out;
  }

  /**
   * BR-GOOD-007: одне написання — один бренд. До будь-якого запису перевіряє, що:
   *  - жоден із синонімів не є активним синонімом ІНШОГО бренду;
   *  - жоден із синонімів не збігається з назвою іншого бренду;
   *  - назва бренду не є синонімом іншого бренду.
   * Порівняння без урахування регістру; у повідомленні — що саме і з яким брендом збіглось.
   *
   * База лише звужує вибірку (ILIKE з екранованими `_`/`%`); збіг вирішує `synonymKey` — той самий
   * ключ, яким `cleanSynonyms` зводить повтори, тож два шляхи порівняння не можуть розійтись.
   *
   * Раніше дубль не відхилявся, а мовчки пропускався (`createMany skipDuplicates` на унікальному
   * індексі) — користувач бачив «збережено», а синоніма не було; при імпорті прайсу написання
   * тоді належало тому бренду, який додав його першим.
   */
  private async assertWritingsFree(
    db: Db,
    orgId: string,
    brandId: string | null,
    name: string,
    synonyms: string[],
  ): Promise<void> {
    const otherBrand = brandId ? { NOT: { id: brandId } } : {};
    const otherBrandSynonym = brandId ? { NOT: { brandId } } : {};
    const nameKey = synonymKey(name);
    const wanted = new Set(synonyms.map(synonymKey));

    const [synonymRows, brandRows] = await Promise.all([
      db.brandSynonym.findMany({
        where: {
          orgId,
          deletedAt: null,
          brand: { deletedAt: null },
          ...otherBrandSynonym,
          OR: [...synonyms, name.trim()].map(s => ({ synonym: insensitive(s) })),
        },
        select: { synonym: true, brand: { select: { name: true } } },
        take: CANDIDATES,
      }),
      synonyms.length
        ? db.brand.findMany({
            where: {
              orgId,
              deletedAt: null,
              ...otherBrand,
              OR: synonyms.map(s => ({ name: insensitive(s) })),
            },
            select: { name: true },
            take: CANDIDATES,
          })
        : Promise.resolve([] as { name: string }[]),
    ]);

    const takenSynonym = synonymRows.find(r => wanted.has(synonymKey(r.synonym)));
    if (takenSynonym)
      throw new ConflictException(
        translateError('err.brand.synonymTaken', getLocale(), {
          synonym: takenSynonym.synonym,
          brand: takenSynonym.brand.name,
        }),
      );
    const brandNamedLikeSynonym = brandRows.find(b => wanted.has(synonymKey(b.name)));
    if (brandNamedLikeSynonym)
      throw new ConflictException(
        translateError('err.brand.synonymIsBrandName', getLocale(), {
          synonym:
            synonyms.find(s => synonymKey(s) === synonymKey(brandNamedLikeSynonym.name)) ??
            brandNamedLikeSynonym.name,
          brand: brandNamedLikeSynonym.name,
        }),
      );
    const synonymLikeName = synonymRows.find(r => synonymKey(r.synonym) === nameKey);
    if (synonymLikeName)
      throw new ConflictException(
        translateError('err.brand.nameIsSynonym', getLocale(), {
          name: name.trim(),
          brand: synonymLikeName.brand.name,
        }),
      );
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
