import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeArticle } from '../../common/utils/normalize-article';
import { BrandsService } from '../brands/brands.service';

/** Що відомо про товар у рядку файла. Порожні й відсутні поля — однаково «немає». */
export interface GoodMatchRow {
  code?: string | null;
  article?: string | null;
  brand?: string | null;
  barcode?: string | null;
  name?: string | null;
}

export type GoodMatchStep = 'code' | 'articleBrand' | 'barcode' | 'article' | 'name';
export type GoodMatchStatus = 'matched' | 'ambiguous' | 'notFound';

export interface GoodMatchCandidate {
  id: string;
  internalCode: string | null;
  sku: string | null;
  name: string;
  brandId: string | null;
  brandName: string | null;
}

export interface GoodMatchResult {
  status: GoodMatchStatus;
  /** Заповнено лише для `matched`. */
  good: GoodMatchCandidate | null;
  /** Крок, на якому рядок розв'язано (`matched`) або зупинено (`ambiguous`). */
  matchedBy: GoodMatchStep | null;
  /** Для `ambiguous` — товари, між якими треба вибрати. */
  candidates: GoodMatchCandidate[];
}

const GOOD_SELECT = {
  id: true,
  internalCode: true,
  sku: true,
  skuNormalized: true,
  name: true,
  barcode: true,
  brandId: true,
  brand: { select: { name: true } },
} satisfies Prisma.GoodSelect;

type GoodRow = Prisma.GoodGetPayload<{ select: typeof GOOD_SELECT }>;

/** Postgres приймає до 32767 параметрів на запит; списки `IN` ріжемо із запасом. */
const IN_CHUNK = 5000;
/** Розмір сторінки читання збігів (див. `findGoods`). */
const PAGE = 5000;

const clean = (s: string | null | undefined): string => (s ?? '').trim();
const lower = (s: string): string => s.toLocaleLowerCase('uk');
const unique = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)));

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * BR-GOOD-008 — єдиний пошук товару для всіх завантажень із файла (рішення власника 2026-10-12).
 *
 * Каскад; перший крок, що дав РІВНО один товар, розв'язує рядок:
 *  1. код (`internalCode`);
 *  2. артикул + бренд — бренд за назвою або синонімом (`BrandsService.resolveByNameOrSynonym`,
 *     включно з нормалізованим синонімом і кирилицею);
 *  3. штрихкод;
 *  4. артикул без бренду;
 *  5. точна назва — лише коли рядок не має ні коду, ні артикула, ні штрихкоду.
 *
 * Кілька товарів на одному кроці → `ambiguous` з кандидатами, а не «який трапився першим»:
 * раніше `lookupGoodsBulk` клав товари в мапу за ключем, і з двох товарів з однаковим артикулом
 * мовчки перемагав останній.
 *
 * Пакетно: один запит на крок для всього файла (N+1 немає). Нічого не пише.
 */
@Injectable()
export class GoodMatcherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brands: BrandsService,
  ) {}

  async matchMany(orgId: string, rows: GoodMatchRow[]): Promise<GoodMatchResult[]> {
    if (rows.length === 0) return [];

    const codes = unique(rows.map(r => clean(r.code)));
    const articles = unique(rows.map(r => normalizeArticle(r.article)));
    const barcodes = unique(rows.map(r => clean(r.barcode)));
    // Назва — останній засіб: шукаємо її лише для рядків без жодного точнішого ключа.
    const names = unique(rows.filter(r => this.hasOnlyName(r)).map(r => clean(r.name)));

    const [byCode, byArticle, byBarcode, byName, brandIdByRaw] = await Promise.all([
      this.loadByCode(orgId, codes),
      this.loadByArticle(orgId, articles),
      this.loadByBarcode(orgId, barcodes),
      this.loadByName(orgId, names),
      this.resolveBrands(orgId, unique(rows.map(r => clean(r.brand)))),
    ]);

    return rows.map(row => {
      const code = clean(row.code);
      if (code) {
        const hits = byCode.get(lower(code)) ?? [];
        const res = this.decide(hits, 'code');
        if (res) return res;
      }

      const article = normalizeArticle(row.article);
      const sameArticle = article ? (byArticle.get(article) ?? []) : [];
      const rawBrand = clean(row.brand);
      const brandId = rawBrand ? (brandIdByRaw.get(lower(rawBrand)) ?? null) : null;
      if (sameArticle.length > 0 && brandId) {
        const res = this.decide(
          sameArticle.filter(g => g.brandId === brandId),
          'articleBrand',
        );
        if (res) return res;
      }

      const barcode = clean(row.barcode);
      if (barcode) {
        const res = this.decide(byBarcode.get(barcode) ?? [], 'barcode');
        if (res) return res;
      }

      if (sameArticle.length > 0) {
        // Бренд у файлі розпізнано, але товару з таким артикулом і цим брендом немає. Товар без
        // бренду в каталозі цьому не суперечить; товар ІНШОГО бренду — суперечить, тож сам
        // не підставляється, а пропонується на вибір.
        const compatible = brandId ? sameArticle.filter(g => g.brandId === null) : sameArticle;
        if (compatible.length === 1) return this.matched(compatible[0], 'article');
        return this.ambiguous(sameArticle, 'article');
      }

      if (this.hasOnlyName(row)) {
        const res = this.decide(byName.get(clean(row.name)) ?? [], 'name');
        if (res) return res;
      }

      return { status: 'notFound', good: null, matchedBy: null, candidates: [] };
    });
  }

  private hasOnlyName(row: GoodMatchRow): boolean {
    return (
      !!clean(row.name) && !clean(row.code) && !normalizeArticle(row.article) && !clean(row.barcode)
    );
  }

  /** Один товар → знайдено; кілька → вибір; жодного → `null` (каскад іде далі). */
  private decide(hits: GoodRow[], step: GoodMatchStep): GoodMatchResult | null {
    if (hits.length === 1) return this.matched(hits[0], step);
    if (hits.length > 1) return this.ambiguous(hits, step);
    return null;
  }

  private matched(good: GoodRow, step: GoodMatchStep): GoodMatchResult {
    return { status: 'matched', good: this.toCandidate(good), matchedBy: step, candidates: [] };
  }

  private ambiguous(goods: GoodRow[], step: GoodMatchStep): GoodMatchResult {
    return {
      status: 'ambiguous',
      good: null,
      matchedBy: step,
      candidates: goods.map(g => this.toCandidate(g)),
    };
  }

  private toCandidate(g: GoodRow): GoodMatchCandidate {
    return {
      id: g.id,
      internalCode: g.internalCode,
      sku: g.sku,
      name: g.name,
      brandId: g.brandId,
      brandName: g.brand?.name ?? null,
    };
  }

  /**
   * Сторінками до кінця, а не одним `take`: артикул не унікальний (той самий номер у кількох
   * брендів), і обрізана вибірка лишила б від двох товарів один — рядок став би «знайдено»
   * замість «вибрати з кількох».
   */
  private async findGoods(orgId: string, where: Prisma.GoodWhereInput): Promise<GoodRow[]> {
    const out: GoodRow[] = [];
    for (let cursor: string | undefined; ;) {
      const page = await this.prisma.good.findMany({
        where: { orgId, deletedAt: null, ...where },
        select: GOOD_SELECT,
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      out.push(...page);
      if (page.length < PAGE) return out;
      cursor = page[page.length - 1].id;
    }
  }

  private async inChunks<T>(values: string[], load: (chunk: string[]) => Promise<T[]>) {
    const out: T[] = [];
    for (let i = 0; i < values.length; i += IN_CHUNK) {
      out.push(...(await load(values.slice(i, i + IN_CHUNK))));
    }
    return out;
  }

  /**
   * Код порівнюється без регістру в самій базі (`LOWER(col) IN (LOWER($1), …)` — не `LIKE`,
   * тож `%` і `_` лишаються звичайними символами). Три написання з JS (як є / верхній / нижній)
   * не знаходили код зі змішаним регістром: префікс нумерації «Тов-» проти «ТОВ-0001» у файлі.
   */
  private async loadByCode(orgId: string, codes: string[]): Promise<Map<string, GoodRow[]>> {
    const map = new Map<string, GoodRow[]>();
    if (codes.length === 0) return map;
    const goods = await this.inChunks(unique(codes.map(lower)), chunk =>
      this.findGoods(orgId, { internalCode: { in: chunk, mode: 'insensitive' } }),
    );
    for (const g of goods) if (g.internalCode) push(map, lower(g.internalCode), g);
    return map;
  }

  private async loadByArticle(orgId: string, articles: string[]): Promise<Map<string, GoodRow[]>> {
    const map = new Map<string, GoodRow[]>();
    if (articles.length === 0) return map;
    const goods = await this.inChunks(articles, chunk =>
      this.findGoods(orgId, { skuNormalized: { in: chunk } }),
    );
    for (const g of goods) if (g.skuNormalized) push(map, g.skuNormalized, g);
    return map;
  }

  /** Штрихкод лежить і в таблиці штрихкодів товару, і (старе поле) у самій картці. */
  private async loadByBarcode(orgId: string, barcodes: string[]): Promise<Map<string, GoodRow[]>> {
    const map = new Map<string, GoodRow[]>();
    if (barcodes.length === 0) return map;
    const wanted = new Set(barcodes);
    const [links, direct] = await Promise.all([
      this.inChunks(barcodes, chunk => this.findBarcodeLinks(orgId, chunk)),
      this.inChunks(barcodes, chunk => this.findGoods(orgId, { barcode: { in: chunk } })),
    ]);
    const linkedIds = unique(links.map(l => l.goodId));
    const linked = await this.inChunks(linkedIds, chunk =>
      this.findGoods(orgId, { id: { in: chunk } }),
    );
    const byId = new Map(linked.map(g => [g.id, g]));

    const seen = new Set<string>();
    const add = (barcode: string, good: GoodRow | undefined) => {
      if (!good || !wanted.has(barcode) || seen.has(`${barcode}|${good.id}`)) return;
      seen.add(`${barcode}|${good.id}`);
      push(map, barcode, good);
    };
    for (const l of links) add(l.barcode, byId.get(l.goodId));
    for (const g of direct) if (g.barcode) add(g.barcode, g);
    return map;
  }

  /** Штрихкод не унікальний у базі — читаємо всі зв'язки сторінками, як і товари. */
  private async findBarcodeLinks(orgId: string, barcodes: string[]) {
    const out: Array<{ id: string; barcode: string; goodId: string }> = [];
    for (let cursor: string | undefined; ;) {
      const page = await this.prisma.goodBarcode.findMany({
        where: { orgId, barcode: { in: barcodes } },
        select: { id: true, barcode: true, goodId: true },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      out.push(...page);
      if (page.length < PAGE) return out;
      cursor = page[page.length - 1].id;
    }
  }

  private async loadByName(orgId: string, names: string[]): Promise<Map<string, GoodRow[]>> {
    const map = new Map<string, GoodRow[]>();
    if (names.length === 0) return map;
    const goods = await this.inChunks(names, chunk =>
      this.findGoods(orgId, { name: { in: chunk } }),
    );
    // Ключ — назва як є: пошук точний, і «Фільтр» з «фільтр» лишаються різними товарами.
    for (const g of goods) push(map, g.name, g);
    return map;
  }

  /** Бренд із файла → id бренду (за назвою або синонімом). Один виклик на кожне написання. */
  private async resolveBrands(orgId: string, rawBrands: string[]) {
    const map = new Map<string, string | null>();
    for (const raw of rawBrands) {
      const key = lower(raw);
      if (map.has(key)) continue;
      const brand = await this.brands.resolveByNameOrSynonym(orgId, raw);
      map.set(key, brand?.id ?? null);
    }
    return map;
  }
}
