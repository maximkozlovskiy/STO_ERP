/**
 * BR-GOOD-008 у шляхах завантаження: кожен шлях віддає пошук товару GoodMatcherService і
 * правильно поводиться з його відповідями («знайдено / кілька / не знайдено»).
 * Сам каскад — `goods/good-matcher.spec.ts`.
 *
 * Mutation-verify:
 *  · у matchLineGoods прибрати гілку `ambiguous` → кейс «кілька товарів → помилка рядка» падає;
 *  · не передавати code / brand / barcode у matchMany → кейс про необов'язкові колонки падає;
 *  · у applyPricingFromList прибрати гілку `ambiguous` → кейс про неоднозначний рядок падає;
 *  · передавати `name` у пошук «Розцінити список» → кейс «назва не бере участі» падає;
 *  · у previewImport не передавати `barcode` / `code` → кейс про колонки майстра падає;
 *  · findExistingGoodRows: `status === 'matched'` замість `!== 'notFound'` → кейс про дублі падає.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { XlsxService, type ImportMapping } from './xlsx.service';
import type { GoodMatcherService } from '../goods/good-matcher.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PricingService } from '../inventory/pricing.service';
import type { DocumentLineImportAdapterRegistry } from './document-line-import.adapter';
import { DocumentGridParserService } from './document-grid-parser.service';
import { catalogMatcher, type CatalogGood } from './good-matcher.testing';

const ORG = '11111111-1111-4111-8111-111111111111';
const PO = '22222222-2222-4222-8222-222222222222';

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet');
  rows.forEach(r => sheet.addRow(r));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const HEADER = ['Артикул (SKU)', 'Назва товару', 'К-ть', 'Ціна, ₴', 'Код', 'Бренд', 'Штрихкод'];

describe('XlsxService — єдиний пошук товару в завантаженнях (BR-GOOD-008)', () => {
  let matchMany: ReturnType<typeof vi.fn>;
  let prisma: {
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn> };
    purchaseOrderLine: {
      findMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    good: { findMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    priceHistory: { createMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let pricing: {
    getPricingContext: ReturnType<typeof vi.fn>;
    computePriceFromRules: ReturnType<typeof vi.fn>;
  };
  let adapter: { loadDoc: ReturnType<typeof vi.fn>; assertDraft: ReturnType<typeof vi.fn> };
  let service: XlsxService;

  const seed = (goods: CatalogGood[]) => matchMany.mockImplementation(catalogMatcher(goods));

  beforeEach(() => {
    matchMany = vi.fn();
    seed([]);
    prisma = {
      purchaseOrder: { findFirst: vi.fn().mockResolvedValue({ id: PO, status: 'DRAFT' }) },
      purchaseOrderLine: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi.fn().mockResolvedValue({}),
      },
      good: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      priceHistory: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };
    pricing = {
      getPricingContext: vi.fn().mockResolvedValue({}),
      computePriceFromRules: vi.fn().mockReturnValue(150),
    };
    adapter = {
      loadDoc: vi.fn().mockResolvedValue({ id: 'doc-1', status: 'DRAFT' }),
      assertDraft: vi.fn(),
    };
    const unused = {} as never;
    service = new XlsxService(
      prisma as unknown as PrismaService,
      pricing as unknown as PricingService,
      unused,
      unused,
      { get: () => adapter } as unknown as DocumentLineImportAdapterRegistry,
      new DocumentGridParserService(),
      { get: vi.fn().mockResolvedValue(null), set: vi.fn() } as never,
      unused,
      { matchMany } as unknown as GoodMatcherService,
      null as never, // workOrderStock — імпорт товарів наряду (BR-WO-021) тут не задіяний
    );
  });

  describe('рядки документа (закупівля / складський документ / запчастини наряду)', () => {
    // guards: BR-GOOD-008
    it('необов’язкові колонки «Код», «Бренд», «Штрихкод» читаються і йдуть у пошук', async () => {
      seed([{ id: 'g1', name: 'Фільтр', sku: 'OC 90', internalCode: 'ТВ-7' }]);
      const buf = await xlsx([HEADER, ['', 'Фільтр', 2, 100, 'ТВ-7', 'Knecht', '4820000000015']]);

      const res = await service.importPOLines(ORG, PO, buf);

      expect(matchMany).toHaveBeenCalledWith(ORG, [
        {
          code: 'ТВ-7',
          article: undefined,
          brand: 'Knecht',
          barcode: '4820000000015',
          name: 'Фільтр',
        },
      ]);
      expect(res).toMatchObject({ created: 1, errors: [] });
      expect(prisma.purchaseOrderLine.createMany).toHaveBeenCalledWith({
        data: [{ orgId: ORG, purchaseOrderId: PO, goodId: 'g1', quantity: 2, price: 100 }],
      });
    });

    // guards: BR-GOOD-008
    it('старий файл на чотири колонки читається як раніше', async () => {
      seed([{ id: 'g1', name: 'Фільтр', sku: 'OC-90' }]);
      const buf = await xlsx([HEADER.slice(0, 4), ['oc 90', 'Фільтр', 1, 50]]);
      const res = await service.importPOLines(ORG, PO, buf);
      expect(res).toMatchObject({ created: 1, errors: [] });
    });

    // guards: BR-GOOD-008
    it('кілька товарів з одним артикулом → помилка рядка з кандидатами, рядок не записано', async () => {
      seed([
        { id: 'g1', name: 'Колодки', sku: 'A1', brand: { name: 'Bosch' } },
        { id: 'g2', name: 'Колодки', sku: 'A-1', brand: { name: 'Febi' } },
      ]);
      const buf = await xlsx([HEADER, ['A1', 'Колодки', 1, 50]]);

      const res = await service.importPOLines(ORG, PO, buf);

      expect(res.created).toBe(0);
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0]).toMatch(/Знайдено кілька товарів \(2\) для «A1»/);
      expect(res.errors[0]).toMatch(/Bosch Колодки/);
      expect(res.errors[0]).toMatch(/Febi Колодки/);
      expect(prisma.purchaseOrderLine.createMany).not.toHaveBeenCalled();
    });

    // guards: BR-GOOD-008
    it('невідомий артикул не підміняється товаром з такою самою назвою', async () => {
      seed([{ id: 'g1', name: 'Фільтр оливи', sku: 'REAL-1' }]);
      const buf = await xlsx([HEADER, ['ПОМИЛКА-9', 'Фільтр оливи', 1, 50]]);
      const res = await service.importPOLines(ORG, PO, buf);
      expect(res).toMatchObject({ created: 0, errors: ['Товар не знайдено: ПОМИЛКА-9'] });
    });

    // guards: BR-GOOD-008
    it('шаблон рядків: нові колонки стоять у кінці, перші чотири — без змін', async () => {
      const workbook = new ExcelJS.Workbook();
      const template = await service.generatePOLinesTemplate();
      await workbook.xlsx.load(
        template.buffer.slice(
          template.byteOffset,
          template.byteOffset + template.byteLength,
        ) as ArrayBuffer,
      );
      const headers = (workbook.worksheets[0]!.getRow(1).values as unknown[]).slice(1);
      expect(headers.slice(0, 4)).toEqual(HEADER.slice(0, 4));
      expect(headers.slice(4).map(h => String(h))).toEqual([
        "Код (необов'язково)",
        "Бренд (необов'язково)",
        "Штрихкод (необов'язково)",
      ]);
    });
  });

  describe('«Розцінити список»', () => {
    const priced = (id: string, sku: string) => ({
      id,
      name: sku,
      sku,
      salePrice: 130,
      purchasePrice: 100,
      category: null,
      goodCategoryId: null,
      goodType: null,
      brandId: null,
    });

    // guards: BR-GOOD-008
    it('шукає за кодом, артикулом із брендом і штрихкодом; назва в пошуку участі не бере', async () => {
      seed([{ id: 'g1', name: 'Масло', sku: 'OIL-1', internalCode: 'K1' }]);
      prisma.good.findMany.mockResolvedValueOnce([priced('g1', 'OIL-1')]);
      const csv = Buffer.from('Код,Артикул,Бренд,Штрихкод,Назва\nK1,,,,Масло\n', 'utf-8');

      const res = await service.applyPricingFromList(ORG, csv, 'csv');

      expect(matchMany).toHaveBeenCalledWith(ORG, [
        { code: 'K1', article: null, brand: null, barcode: null },
      ]);
      expect(res).toMatchObject({ found: 1, updated: 1, notFound: [] });
    });

    // guards: BR-GOOD-008
    it('неоднозначний рядок не розцінюється навмання — іде в «не знайдено» з поясненням', async () => {
      seed([
        { id: 'g1', name: 'A', sku: 'A1' },
        { id: 'g2', name: 'B', sku: 'A-1' },
      ]);
      const csv = Buffer.from('sku\nA1\n', 'utf-8');

      const res = await service.applyPricingFromList(ORG, csv, 'csv');

      expect(res.found).toBe(0);
      expect(res.notFound).toEqual(['A1 (знайдено кілька товарів — вкажіть код або бренд)']);
      expect(prisma.good.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('майстер імпорту рядків (прев’ю)', () => {
    const MAPPING: ImportMapping = {
      startRow: 2,
      codeCol: 1,
      articleCol: 2,
      brandCol: 3,
      barcodeCol: 4,
      nameCol: 5,
      quantityCol: 6,
      priceCol: 7,
    };
    const preview = (buf: Buffer) =>
      service.previewImport(ORG, 'PURCHASE_ORDER', 'doc-1', buf, 'f.xlsx', MAPPING);

    // guards: BR-GOOD-008
    it('код, бренд (зокрема кирилицею) і штрихкод із файла доходять до пошуку', async () => {
      seed([{ id: 'g1', name: 'Фільтр', barcodes: [{ barcode: '4820000000015' }] }]);
      const buf = await xlsx([
        ['Код', 'Артикул', 'Бренд', 'Штрихкод', 'Назва', 'К-ть', 'Ціна'],
        ['K-9', '', 'Бош', '4820000000015', 'Фільтр', 1, 10],
      ]);

      const rows = await preview(buf);

      expect(matchMany).toHaveBeenCalledWith(ORG, [
        { code: 'K-9', article: null, brand: 'Бош', barcode: '4820000000015' },
      ]);
      expect(rows[0]).toMatchObject({
        status: 'matched',
        matchedGoodId: 'g1',
        rawBarcode: '4820000000015',
      });
    });

    // guards: BR-GOOD-008
    it('рядок лише зі штрихкодом — рядок даних, а не порожній', async () => {
      seed([{ id: 'g1', name: 'Фільтр', barcode: '4820000000015' }]);
      const buf = await xlsx([
        ['Код', 'Артикул', 'Бренд', 'Штрихкод', 'Назва', 'К-ть', 'Ціна'],
        ['', '', '', '4820000000015', '', 3, 10],
      ]);
      const rows = await preview(buf);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'matched', matchedGoodId: 'g1', quantity: 3 });
    });

    // guards: BR-GOOD-008
    it('символи % і _ у назві рядка — звичайні символи в запиті підказок', async () => {
      const buf = await xlsx([
        ['Код', 'Артикул', 'Бренд', 'Штрихкод', 'Назва', 'К-ть', 'Ціна'],
        ['', '', '', '', '100%_знижка', 1, 10],
      ]);
      await preview(buf);
      const where = prisma.good.findMany.mock.calls[0]![0].where as {
        OR: { name?: { contains: string } }[];
      };
      expect(where.OR[0]!.name!.contains).toBe('100\\%\\_знижка');
    });
  });

  describe('імпорт товарів каталогу', () => {
    // guards: BR-GOOD-008
    it('«товар уже є» — і коли знайдено один, і коли з таким артикулом їх кілька', async () => {
      seed([
        { id: 'g1', name: 'A', sku: '04E 129 620' },
        { id: 'g2', name: 'B', sku: 'DUP' },
        { id: 'g3', name: 'C', sku: 'D-U-P' },
      ]);
      const exists = await service.findExistingGoodRows(ORG, [
        { sku: '04E-129-620', name: 'A' },
        { sku: 'dup', name: 'B' },
        { sku: 'NEW-1', name: 'N' },
        { name: 'Без артикула' },
      ]);
      expect(exists).toEqual([true, true, false, false]);
      // Назва в пошук не передається: товар без артикула завжди новий, як і раніше.
      expect(matchMany).toHaveBeenCalledWith(ORG, [
        { article: '04E-129-620' },
        { article: 'dup' },
        { article: 'NEW-1' },
        { article: undefined },
      ]);
    });
  });
});
