/**
 * Тестовий двійник GoodMatcherService для спеків завантажень: шукає товар у переданому переліку
 * за тим самим порядком ключів (код → артикул + бренд → штрихкод → артикул → назва), щоб спеки
 * шляхів імпорту перевіряли СВОЮ логіку (плани запису, помилки рядків), а не повторювали пошук.
 * Справжній каскад і його межі стереже `goods/good-matcher.spec.ts` (BR-GOOD-008).
 */
import { normalizeArticle } from '../../common/utils/normalize-article';
import type {
  GoodMatchCandidate,
  GoodMatchResult,
  GoodMatchRow,
} from '../goods/good-matcher.service';

export interface CatalogGood {
  id: string;
  name: string;
  sku?: string | null;
  internalCode?: string | null;
  barcode?: string | null;
  barcodes?: { barcode: string }[];
  brandId?: string | null;
  brand?: { name: string } | null;
}

const lower = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

function toCandidate(g: CatalogGood): GoodMatchCandidate {
  return {
    id: g.id,
    internalCode: g.internalCode ?? null,
    sku: g.sku ?? null,
    name: g.name,
    brandId: g.brandId ?? null,
    brandName: g.brand?.name ?? null,
  };
}

function decide(hits: CatalogGood[], step: GoodMatchResult['matchedBy']): GoodMatchResult | null {
  if (hits.length === 1)
    return { status: 'matched', good: toCandidate(hits[0]), matchedBy: step, candidates: [] };
  if (hits.length > 1)
    return { status: 'ambiguous', good: null, matchedBy: step, candidates: hits.map(toCandidate) };
  return null;
}

export function matchInCatalog(catalog: CatalogGood[], row: GoodMatchRow): GoodMatchResult {
  const code = lower(row.code);
  const article = normalizeArticle(row.article);
  const brand = lower(row.brand);
  const barcode = (row.barcode ?? '').trim();
  const sameArticle = article ? catalog.filter(g => normalizeArticle(g.sku) === article) : [];

  const res =
    (code
      ? decide(
          catalog.filter(g => lower(g.internalCode) === code),
          'code',
        )
      : null) ??
    (brand && sameArticle.length
      ? decide(
          sameArticle.filter(g => lower(g.brand?.name) === brand),
          'articleBrand',
        )
      : null) ??
    (barcode
      ? decide(
          catalog.filter(
            g => g.barcode === barcode || (g.barcodes ?? []).some(b => b.barcode === barcode),
          ),
          'barcode',
        )
      : null) ??
    decide(sameArticle, 'article') ??
    (!code && !article && !barcode && row.name
      ? decide(
          catalog.filter(g => lower(g.name) === lower(row.name)),
          'name',
        )
      : null);
  return res ?? { status: 'notFound', good: null, matchedBy: null, candidates: [] };
}

/** Реалізація `matchMany` поверх переліку товарів — для `vi.fn().mockImplementation(...)`. */
export const catalogMatcher =
  (catalog: CatalogGood[]) =>
  (_orgId: string, rows: GoodMatchRow[]): Promise<GoodMatchResult[]> =>
    Promise.resolve(rows.map(r => matchInCatalog(catalog, r)));
