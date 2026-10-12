/**
 * BR-GOOD-008 — єдиний пошук товару для завантажень із файла (рішення власника 2026-10-12):
 * код → артикул + бренд (назва або синонім) → штрихкод → артикул без бренду → точна назва.
 *
 * Mutation-verify:
 *  · поміняти місцями кроки «код» і «артикул + бренд» → кейс про порядок падає;
 *  · крок «штрихкод» поставити після «артикул без бренду» → кейс «штрихкод сильніший…» падає;
 *  · `decide` повертає перший товар замість `ambiguous` → кейси про неоднозначність падають;
 *  · прибрати `deletedAt: null` / `orgId` з `findGoods` → кейси про видалений товар і чужу
 *    організацію падають;
 *  · прибрати фільтр `g.brandId === null` → кейс «товар іншого бренду не підставляється» падає;
 *  · прибрати умову `hasOnlyName` → кейс «назва не шукається, коли є артикул» падає;
 *  · прибрати `mode: 'insensitive'` з пошуку коду → кейс про змішаний регістр падає;
 *  · `findGoods` читає одну сторінку (`return page`) → кейс «збігів більше, ніж сторінка» падає;
 *  · ключ мапи назв знову `lower(g.name)` → кейс про назви з різним регістром падає.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoodMatcherService, type GoodMatchRow } from './good-matcher.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { BrandsService } from '../brands/brands.service';
import { normalizeArticle } from '../../common/utils/normalize-article';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const BOSCH = 'b0000000-0000-4000-8000-000000000001';
const FEBI = 'b0000000-0000-4000-8000-000000000002';

interface Good {
  id: string;
  orgId: string;
  internalCode: string | null;
  sku: string | null;
  name: string;
  barcode: string | null;
  brandId: string | null;
  deletedAt: Date | null;
}
interface Barcode {
  orgId: string;
  goodId: string;
  barcode: string;
}

type InFilter = { in: string[] };
interface GoodWhere {
  orgId: string;
  deletedAt: null;
  internalCode?: InFilter & { mode?: 'insensitive' };
  skuNormalized?: InFilter;
  barcode?: InFilter;
  name?: InFilter;
  id?: InFilter;
}

const BRAND_NAMES: Record<string, string> = { [BOSCH]: 'Bosch', [FEBI]: 'Febi' };

function good(id: string, patch: Partial<Good>): Good {
  return {
    id,
    orgId: ORG,
    internalCode: null,
    sku: null,
    name: `Товар ${id}`,
    barcode: null,
    brandId: null,
    deletedAt: null,
    ...patch,
  };
}

describe('GoodMatcherService — пошук товару за рядком файла (BR-GOOD-008)', () => {
  let goods: Good[];
  let barcodes: Barcode[];
  let goodFindMany: ReturnType<typeof vi.fn>;
  let resolveBrand: ReturnType<typeof vi.fn>;
  let service: GoodMatcherService;

  const match = async (row: GoodMatchRow) => (await service.matchMany(ORG, [row]))[0];

  beforeEach(() => {
    goods = [];
    barcodes = [];
    goodFindMany = vi.fn((args: { where: GoodWhere; take?: number; cursor?: { id: string } }) => {
      const { where } = args;
      // Сервіс зобов'язаний обмежити вибірку організацією і живими товарами.
      expect(where.orgId).toBeTruthy();
      expect(where.deletedAt).toBeNull();
      const all = goods.filter(g => {
        if (g.orgId !== where.orgId || g.deletedAt) return false;
        if (where.internalCode) {
          // Як у базі: без `mode: 'insensitive'` збіг точний, з ним — LOWER(col) IN (LOWER(…)).
          const fold = (v: string) => (where.internalCode?.mode ? v.toLowerCase() : v);
          if (!where.internalCode.in.map(fold).includes(fold(g.internalCode ?? ''))) return false;
        }
        if (where.skuNormalized && !where.skuNormalized.in.includes(normalizeArticle(g.sku)))
          return false;
        if (where.barcode && !where.barcode.in.includes(g.barcode ?? '')) return false;
        if (where.name && !where.name.in.includes(g.name)) return false;
        if (where.id && !where.id.in.includes(g.id)) return false;
        return true;
      });
      // Як у базі: порядок за id, курсор пропускає все до себе включно, `take` обрізає.
      all.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
      const from = args.cursor ? all.findIndex(g => g.id === args.cursor?.id) + 1 : 0;
      const rows = all.slice(from, args.take ? from + args.take : undefined);
      return Promise.resolve(
        rows.map(g => ({
          id: g.id,
          internalCode: g.internalCode,
          sku: g.sku,
          skuNormalized: g.sku ? normalizeArticle(g.sku) : null,
          name: g.name,
          barcode: g.barcode,
          brandId: g.brandId,
          brand: g.brandId ? { name: BRAND_NAMES[g.brandId] } : null,
        })),
      );
    });
    const prisma = {
      good: { findMany: goodFindMany },
      goodBarcode: {
        findMany: vi.fn(({ where }: { where: { orgId: string; barcode: InFilter } }) =>
          Promise.resolve(
            barcodes
              .filter(b => b.orgId === where.orgId && where.barcode.in.includes(b.barcode))
              .map(b => ({ barcode: b.barcode, goodId: b.goodId })),
          ),
        ),
      },
    } as unknown as PrismaService;
    // Бренд за назвою, синонімом латиницею чи кирилицею — справа BrandsService (BR-GOOD-007).
    resolveBrand = vi.fn((_org: string, raw: string) => {
      const key = raw.trim().toLowerCase();
      if (key === 'bosch' || key === 'бош') return Promise.resolve({ id: BOSCH });
      if (key === 'febi') return Promise.resolve({ id: FEBI });
      return Promise.resolve(null);
    });
    service = new GoodMatcherService(prisma, {
      resolveByNameOrSynonym: resolveBrand,
    } as unknown as BrandsService);
  });

  // guards: BR-GOOD-008
  it('код: знаходить товар без урахування регістру й пробілів по краях', async () => {
    goods.push(good('g1', { internalCode: 'ТВ-000123' }));
    const res = await match({ code: '  тв-000123 ' });
    expect(res).toMatchObject({ status: 'matched', matchedBy: 'code', good: { id: 'g1' } });
  });

  // guards: BR-GOOD-008
  it('код зі змішаним регістром у базі («Тов-0001») знаходиться за будь-яким написанням у файлі', async () => {
    goods.push(good('g1', { internalCode: 'Тов-0001' }));
    for (const code of ['ТОВ-0001', 'тов-0001', 'Тов-0001', 'тОВ-0001']) {
      expect(await match({ code })).toMatchObject({ status: 'matched', good: { id: 'g1' } });
    }
    // Порівняння без регістру — не шаблон: «%» і «_» у коді з файла нічого не «знаходять».
    expect((await match({ code: '%' })).status).toBe('notFound');
    expect((await match({ code: 'тов_0001' })).status).toBe('notFound');
  });

  // guards: BR-GOOD-008
  it('збігів більше, ніж сторінка читання: дочитує до кінця, а не обрізає вибірку', async () => {
    // 5001 товар з одним артикулом — більше за сторінку.
    for (let i = 0; i <= 5000; i++)
      goods.push(good(`g${String(i).padStart(5, '0')}`, { sku: 'A1' }));
    // Другий артикул має два товари, і другий із них лежить ЗА межею першої сторінки: обрізана
    // вибірка лишила б один товар, і рядок став би «знайдено» замість «вибрати з кількох».
    goods.push(good('a-first', { sku: 'B2' }), good('z-last', { sku: 'B2' }));
    const [many, pair] = await service.matchMany(ORG, [{ article: 'A1' }, { article: 'B2' }]);
    expect(many.status).toBe('ambiguous');
    expect(many.candidates).toHaveLength(5001);
    expect(pair.status).toBe('ambiguous');
    expect(pair.candidates.map(c => c.id).sort()).toEqual(['a-first', 'z-last']);
  });

  // guards: BR-GOOD-008
  it('назви, що різняться лише регістром, — різні товари: кожен рядок знаходить свій', async () => {
    goods.push(good('g1', { name: 'Фільтр' }), good('g2', { name: 'фільтр' }));
    const res = await service.matchMany(ORG, [{ name: 'Фільтр' }, { name: 'фільтр' }]);
    expect(res.map(r => [r.status, r.good?.id])).toEqual([
      ['matched', 'g1'],
      ['matched', 'g2'],
    ]);
  });

  // guards: BR-GOOD-008
  it('артикул + бренд: артикул порівнюється нормалізовано, бренд — за назвою', async () => {
    goods.push(good('g1', { sku: '04E-129-620', brandId: BOSCH }));
    goods.push(good('g2', { sku: '04E 129 620', brandId: FEBI }));
    const res = await match({ article: '04e.129/620', brand: 'BOSCH' });
    expect(res).toMatchObject({ status: 'matched', matchedBy: 'articleBrand', good: { id: 'g1' } });
  });

  // guards: BR-GOOD-008
  it('артикул + синонім бренду кирилицею: бренд розв’язує BrandsService', async () => {
    goods.push(good('g1', { sku: 'A1', brandId: BOSCH }));
    goods.push(good('g2', { sku: 'A1', brandId: FEBI }));
    const res = await match({ article: 'A1', brand: 'Бош' });
    expect(res).toMatchObject({ status: 'matched', matchedBy: 'articleBrand', good: { id: 'g1' } });
    expect(resolveBrand).toHaveBeenCalledWith(ORG, 'Бош');
  });

  // guards: BR-GOOD-008
  it('штрихкод: і з таблиці штрихкодів, і зі старого поля картки', async () => {
    goods.push(good('g1', {}));
    goods.push(good('g2', { barcode: '4820000000022' }));
    barcodes.push({ orgId: ORG, goodId: 'g1', barcode: '4820000000015' });
    expect(await match({ barcode: '4820000000015' })).toMatchObject({
      status: 'matched',
      matchedBy: 'barcode',
      good: { id: 'g1' },
    });
    expect(await match({ barcode: '4820000000022' })).toMatchObject({
      status: 'matched',
      matchedBy: 'barcode',
      good: { id: 'g2' },
    });
  });

  // guards: BR-GOOD-008
  it('порядок: код сильніший за артикул + бренд і за штрихкод', async () => {
    goods.push(good('by-code', { internalCode: 'K1' }));
    goods.push(good('by-article', { sku: 'A1', brandId: BOSCH, barcode: '111' }));
    const res = await match({ code: 'K1', article: 'A1', brand: 'Bosch', barcode: '111' });
    expect(res).toMatchObject({ status: 'matched', matchedBy: 'code', good: { id: 'by-code' } });
  });

  // guards: BR-GOOD-008
  it('порядок: артикул + бренд сильніший за штрихкод', async () => {
    goods.push(good('by-article', { sku: 'A1', brandId: BOSCH }));
    goods.push(good('by-barcode', { barcode: '111' }));
    const res = await match({ article: 'A1', brand: 'Bosch', barcode: '111' });
    expect(res).toMatchObject({ matchedBy: 'articleBrand', good: { id: 'by-article' } });
  });

  // guards: BR-GOOD-008
  it('порядок: штрихкод сильніший за артикул без бренду', async () => {
    goods.push(good('by-article', { sku: 'A1' }));
    goods.push(good('by-barcode', { barcode: '111' }));
    const res = await match({ article: 'A1', barcode: '111' });
    expect(res).toMatchObject({ matchedBy: 'barcode', good: { id: 'by-barcode' } });
  });

  // guards: BR-GOOD-008
  it('невідомий код не зупиняє каскад: далі шукаємо за артикулом', async () => {
    goods.push(good('g1', { sku: 'A1' }));
    const res = await match({ code: 'НЕМАЄ', article: 'A1' });
    expect(res).toMatchObject({ status: 'matched', matchedBy: 'article', good: { id: 'g1' } });
  });

  // guards: BR-GOOD-008
  it('артикул без бренду: один товар — знайдено, кілька — вибір із кандидатів', async () => {
    goods.push(good('g1', { sku: 'A1', brandId: BOSCH }));
    expect(await match({ article: 'A1' })).toMatchObject({
      status: 'matched',
      matchedBy: 'article',
      good: { id: 'g1', brandName: 'Bosch' },
    });

    goods.push(good('g2', { sku: 'A-1', brandId: FEBI }));
    const res = await match({ article: 'A1' });
    expect(res.status).toBe('ambiguous');
    expect(res.good).toBeNull();
    expect(res.candidates.map(c => c.id).sort()).toEqual(['g1', 'g2']);
  });

  // guards: BR-GOOD-008
  it('два товари з однаковим артикулом і брендом — вибір, а не «останній у мапі»', async () => {
    goods.push(good('g1', { sku: 'A1', brandId: BOSCH }));
    goods.push(good('g2', { sku: 'A1', brandId: BOSCH }));
    const res = await match({ article: 'A1', brand: 'Bosch' });
    expect(res).toMatchObject({ status: 'ambiguous', matchedBy: 'articleBrand' });
    expect(res.candidates).toHaveLength(2);
  });

  // guards: BR-GOOD-008
  it('бренд у файлі розпізнано, а товар з таким артикулом — іншого бренду: не підставляється', async () => {
    goods.push(good('febi', { sku: 'A1', brandId: FEBI }));
    const res = await match({ article: 'A1', brand: 'Bosch' });
    expect(res.status).toBe('ambiguous');
    expect(res.candidates.map(c => c.id)).toEqual(['febi']);
  });

  // guards: BR-GOOD-008
  it('бренд у файлі розпізнано, а в картці товару бренду немає: товар підходить', async () => {
    goods.push(good('g1', { sku: 'A1', brandId: null }));
    const res = await match({ article: 'A1', brand: 'Bosch' });
    expect(res).toMatchObject({ status: 'matched', matchedBy: 'article', good: { id: 'g1' } });
  });

  // guards: BR-GOOD-008
  it('бренд у файлі невідомий системі: шукаємо як артикул без бренду', async () => {
    goods.push(good('g1', { sku: 'A1', brandId: FEBI }));
    const res = await match({ article: 'A1', brand: 'Невідомий' });
    expect(res).toMatchObject({ status: 'matched', matchedBy: 'article', good: { id: 'g1' } });
  });

  // guards: BR-GOOD-008
  it('назва: шукається лише коли в рядку немає коду, артикула і штрихкоду', async () => {
    goods.push(good('g1', { name: 'Фільтр масляний' }));
    expect(await match({ name: 'фільтр МАСЛЯНИЙ' })).toMatchObject({ status: 'notFound' });
    expect(await match({ name: 'Фільтр масляний' })).toMatchObject({
      status: 'matched',
      matchedBy: 'name',
      good: { id: 'g1' },
    });
    // Артикул є, але не знайдений → назва НЕ рятує рядок: інакше помилка в артикулі тихо
    // підставляла б товар із тією самою назвою.
    expect(await match({ article: 'ZZZ', name: 'Фільтр масляний' })).toMatchObject({
      status: 'notFound',
    });
  });

  // guards: BR-GOOD-008
  it('видалений товар і товар чужої організації не знаходяться', async () => {
    goods.push(good('deleted', { internalCode: 'K1', deletedAt: new Date() }));
    goods.push(good('foreign', { internalCode: 'K2', orgId: OTHER_ORG, sku: 'A2' }));
    barcodes.push({ orgId: OTHER_ORG, goodId: 'foreign', barcode: '222' });
    expect((await match({ code: 'K1' })).status).toBe('notFound');
    expect((await match({ code: 'K2' })).status).toBe('notFound');
    expect((await match({ article: 'A2' })).status).toBe('notFound');
    expect((await match({ barcode: '222' })).status).toBe('notFound');
  });

  // guards: BR-GOOD-008
  it('порожній рядок і рядок із самими пробілами — «не знайдено», без запитів за порожнім ключем', async () => {
    const res = await service.matchMany(ORG, [{}, { code: '  ', article: ' - ', barcode: '' }]);
    expect(res.map(r => r.status)).toEqual(['notFound', 'notFound']);
    expect(goodFindMany).not.toHaveBeenCalled();
  });

  // guards: BR-GOOD-008
  it('пакет: результати йдуть у порядку рядків, бренд розв’язується раз на написання', async () => {
    goods.push(good('g1', { sku: 'A1', brandId: BOSCH }));
    goods.push(good('g2', { sku: 'A2', brandId: BOSCH }));
    const res = await service.matchMany(ORG, [
      { article: 'A2', brand: 'Bosch' },
      { article: 'нема' },
      { article: 'A1', brand: 'BOSCH' },
    ]);
    expect(res.map(r => r.good?.id ?? null)).toEqual(['g2', null, 'g1']);
    expect(resolveBrand).toHaveBeenCalledTimes(1);
    // Один запит за артикулами на весь файл, а не по запиту на рядок.
    expect(goodFindMany).toHaveBeenCalledTimes(1);
  });
});
