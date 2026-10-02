import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { XlsxService, type ImportMapping } from './xlsx.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PricingService } from '../inventory/pricing.service';
import { GoodsService } from '../goods/goods.service';
import { BrandsService } from '../brands/brands.service';
import { DocumentLineImportAdapterRegistry } from './document-line-import.adapter';
import { DocumentGridParserService } from './document-grid-parser.service';
import { CacheService } from '../../redis/cache.service';

const ORG = 'org-1';
const MAPPING: ImportMapping = {
  startRow: 2,
  codeCol: 1,
  articleCol: 2,
  brandCol: 3,
  nameCol: 4,
  quantityCol: 5,
  priceCol: 6,
};

async function buildXlsx(rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('list');
  sheet.addRow(['code', 'article', 'brand', 'name', 'qty', 'price']); // header (row 1)
  rows.forEach(r => sheet.addRow(r));
  return (await wb.xlsx.writeBuffer()) as Buffer;
}

describe('XlsxService — generic import (preview/apply)', () => {
  let service: XlsxService;
  let prisma: {
    good: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let goodsService: { create: ReturnType<typeof vi.fn> };
  let brandsService: {
    resolveByNameOrSynonym: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  let adapter: {
    docType: string;
    loadDoc: ReturnType<typeof vi.fn>;
    assertDraft: ReturnType<typeof vi.fn>;
    replaceLines: ReturnType<typeof vi.fn>;
    appendLines: ReturnType<typeof vi.fn>;
  };
  let registry: { get: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      good: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
    };
    goodsService = { create: vi.fn() };
    brandsService = { resolveByNameOrSynonym: vi.fn().mockResolvedValue(null), create: vi.fn() };
    adapter = {
      docType: 'PURCHASE_ORDER',
      loadDoc: vi.fn().mockResolvedValue({ id: 'doc-1', status: 'DRAFT', currencyId: 'cur-1' }),
      assertDraft: vi.fn().mockImplementation((s: string) => {
        if (s !== 'DRAFT') throw new ForbiddenException('not draft');
      }),
      replaceLines: vi.fn().mockResolvedValue(undefined),
      appendLines: vi.fn().mockResolvedValue(undefined),
    };
    registry = { get: vi.fn().mockReturnValue(adapter) };

    const module = await Test.createTestingModule({
      providers: [
        XlsxService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PricingService,
          useValue: { getActiveRulesForOrg: vi.fn(), computePriceFromRules: vi.fn() },
        },
        { provide: GoodsService, useValue: goodsService },
        { provide: BrandsService, useValue: brandsService },
        { provide: DocumentLineImportAdapterRegistry, useValue: registry },
        DocumentGridParserService,
        // sto-optimize: OCR-grid кеш за хешем вмісту. xlsx-канал цих специв кеш не чіпає
        // (parseGridCached повертається рано для не-OCR форматів), але DI потребує провайдера.
        { provide: CacheService, useValue: { get: vi.fn().mockResolvedValue(null), set: vi.fn() } },
      ],
    }).compile();
    service = module.get(XlsxService);
  });

  // ─── previewImport ───────────────────────────────────────────────────────────

  describe('previewImport', () => {
    it('404 якщо документ не знайдено', async () => {
      adapter.loadDoc.mockResolvedValueOnce(null);
      const buf = await buildXlsx([['C1', '04E-129-620', '', 'Товар', 2, 100]]);
      await expect(
        service.previewImport(ORG, 'PURCHASE_ORDER', 'doc-1', buf, 'f.xlsx', MAPPING),
      ).rejects.toThrow(NotFoundException);
    });

    it('Forbidden якщо документ не DRAFT', async () => {
      adapter.loadDoc.mockResolvedValueOnce({
        id: 'doc-1',
        status: 'ORDERED',
        currencyId: 'cur-1',
      });
      const buf = await buildXlsx([['C1', '04E-129-620', '', 'Товар', 2, 100]]);
      await expect(
        service.previewImport(ORG, 'PURCHASE_ORDER', 'doc-1', buf, 'f.xlsx', MAPPING),
      ).rejects.toThrow(ForbiddenException);
    });

    it('matched: exact skuNormalized (1 кандидат) → matched + matchedGoodId', async () => {
      // Артикул '04E-129-620' нормалізується у '04E129620' — те саме, що збережений SKU.
      prisma.good.findMany.mockResolvedValueOnce([
        { id: 'g-1', sku: '04E 129 620', name: 'Насос', brandId: null, brand: null },
      ]);
      const buf = await buildXlsx([['C1', '04E-129-620', '', 'Насос', 2, 100]]);

      const rows = await service.previewImport(
        ORG,
        'PURCHASE_ORDER',
        'doc-1',
        buf,
        'f.xlsx',
        MAPPING,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        rowIndex: 2,
        status: 'matched',
        matchedGoodId: 'g-1',
        quantity: 2,
        price: 100,
      });
    });

    it('matched: exact + бренд резолвиться → звужує до 1', async () => {
      prisma.good.findMany.mockResolvedValueOnce([
        { id: 'g-a', sku: 'ART1', name: 'A', brandId: 'brand-a', brand: { name: 'Bosch' } },
        { id: 'g-b', sku: 'ART1', name: 'B', brandId: 'brand-b', brand: { name: 'Mann' } },
      ]);
      brandsService.resolveByNameOrSynonym.mockResolvedValueOnce({ id: 'brand-a' });
      const buf = await buildXlsx([['', 'ART1', 'Bosch', 'A', 1, 50]]);

      const rows = await service.previewImport(
        ORG,
        'PURCHASE_ORDER',
        'doc-1',
        buf,
        'f.xlsx',
        MAPPING,
      );
      expect(rows[0]!.status).toBe('matched');
      expect(rows[0]!.matchedGoodId).toBe('g-a');
    });

    it('ambiguous: exact skuNormalized кілька кандидатів без бренду → ambiguous + candidates', async () => {
      prisma.good.findMany.mockResolvedValueOnce([
        { id: 'g-a', sku: 'ART1', name: 'A', brandId: 'brand-a', brand: { name: 'Bosch' } },
        { id: 'g-b', sku: 'ART1', name: 'B', brandId: 'brand-b', brand: { name: 'Mann' } },
      ]);
      const buf = await buildXlsx([['', 'ART1', '', 'A', 1, 50]]);

      const rows = await service.previewImport(
        ORG,
        'PURCHASE_ORDER',
        'doc-1',
        buf,
        'f.xlsx',
        MAPPING,
      );
      expect(rows[0]!.status).toBe('ambiguous');
      expect(rows[0]!.candidates).toHaveLength(2);
      expect(rows[0]!.candidates[0]).toMatchObject({ id: 'g-a', sku: 'ART1', brandName: 'Bosch' });
    });

    it('substring fallback: немає exact, але name ILIKE → ambiguous з кандидатами', async () => {
      prisma.good.findMany
        .mockResolvedValueOnce([]) // exact bulk lookup — нічого
        .mockResolvedValueOnce([
          { id: 'g-sub', sku: 'XYZ', name: 'Масло 5W40', brandId: null, brand: null },
        ]); // substring
      const buf = await buildXlsx([['', 'NOEXACT', '', 'Масло', 1, 10]]);

      const rows = await service.previewImport(
        ORG,
        'PURCHASE_ORDER',
        'doc-1',
        buf,
        'f.xlsx',
        MAPPING,
      );
      expect(rows[0]!.status).toBe('ambiguous');
      expect(rows[0]!.candidates[0]!.id).toBe('g-sub');
    });

    it('notFound: ані exact, ані substring', async () => {
      prisma.good.findMany.mockResolvedValue([]); // exact + substring обидва порожні
      const buf = await buildXlsx([['', 'UNKNOWN', '', 'Невідомо', 1, 10]]);

      const rows = await service.previewImport(
        ORG,
        'PURCHASE_ORDER',
        'doc-1',
        buf,
        'f.xlsx',
        MAPPING,
      );
      expect(rows[0]!.status).toBe('notFound');
      expect(rows[0]!.matchedGoodId).toBeNull();
      expect(rows[0]!.candidates).toEqual([]);
    });

    it('bulk-no-N+1: exact lookup один findMany на всі артикули', async () => {
      prisma.good.findMany.mockResolvedValueOnce([
        { id: 'g-1', sku: 'A1', name: 'A', brandId: null, brand: null },
        { id: 'g-2', sku: 'A2', name: 'B', brandId: null, brand: null },
      ]);
      const buf = await buildXlsx([
        ['', 'A1', '', 'A', 1, 10],
        ['', 'A2', '', 'B', 2, 20],
      ]);

      const rows = await service.previewImport(
        ORG,
        'PURCHASE_ORDER',
        'doc-1',
        buf,
        'f.xlsx',
        MAPPING,
      );
      expect(rows).toHaveLength(2);
      // Рівно 1 findMany (exact bulk), бо обидва рядки matched → substring не викликається.
      expect(prisma.good.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.good.findMany.mock.calls[0]![0]).toMatchObject({
        where: expect.objectContaining({
          orgId: ORG,
          deletedAt: null,
          skuNormalized: { in: ['A1', 'A2'] },
        }),
      });
    });
  });

  // ─── applyImport ───────────────────────────────────────────────────────────────

  describe('applyImport', () => {
    it('404 якщо документ не знайдено', async () => {
      adapter.loadDoc.mockResolvedValueOnce(null);
      await expect(
        service.applyImport(ORG, 'PURCHASE_ORDER', 'doc-1', [
          { rowIndex: 2, action: 'use', goodId: 'g-1', quantity: 1, price: 10 },
        ]),
      ).rejects.toThrow(NotFoundException);
    });

    it('Forbidden якщо документ не DRAFT (DRAFT-guard)', async () => {
      adapter.loadDoc.mockResolvedValueOnce({ id: 'doc-1', status: 'CONFIRMED', currencyId: null });
      await expect(
        service.applyImport(ORG, 'STOCK_DOCUMENT', 'doc-1', [
          { rowIndex: 2, action: 'use', goodId: 'g-1', quantity: 1, price: 10 },
        ]),
      ).rejects.toThrow(ForbiddenException);
    });

    it("action='use': валідує goodId у org, збирає рядки → replaceLines", async () => {
      prisma.good.findFirst.mockResolvedValueOnce({ id: 'g-1' });
      await service.applyImport(ORG, 'PURCHASE_ORDER', 'doc-1', [
        { rowIndex: 2, action: 'use', goodId: 'g-1', quantity: 3, price: 100 },
      ]);
      // tenant guard read
      expect(prisma.good.findFirst).toHaveBeenCalledWith({
        where: { id: 'g-1', orgId: ORG, deletedAt: null },
        select: { id: true },
      });
      expect(adapter.replaceLines).toHaveBeenCalledTimes(1);
      const callArgs = adapter.replaceLines.mock.calls[0]!;
      expect(callArgs[1]).toBe(ORG);
      expect(callArgs[2]).toBe('doc-1');
      expect(callArgs[3]).toEqual([{ goodId: 'g-1', quantity: 3, price: 100 }]);
    });

    it("action='use': чужий goodId (не в org) → NotFoundException, replaceLines не викликано", async () => {
      prisma.good.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.applyImport(ORG, 'PURCHASE_ORDER', 'doc-1', [
          { rowIndex: 2, action: 'use', goodId: 'foreign', quantity: 1, price: 10 },
        ]),
      ).rejects.toThrow(NotFoundException);
      expect(adapter.replaceLines).not.toHaveBeenCalled();
    });

    it("action='create': створює Good (без бренду) → goodId у рядках", async () => {
      goodsService.create.mockResolvedValueOnce({ id: 'new-good' });
      await service.applyImport(ORG, 'PURCHASE_ORDER', 'doc-1', [
        {
          rowIndex: 2,
          action: 'create',
          createData: { name: 'Новий товар', sku: 'NEW-1' },
          quantity: 5,
          price: 200,
        },
      ]);
      expect(goodsService.create).toHaveBeenCalledWith(ORG, {
        name: 'Новий товар',
        sku: 'NEW-1',
        brandId: undefined,
        purchasePrice: 200,
      });
      expect(adapter.replaceLines.mock.calls[0]![3]).toEqual([
        { goodId: 'new-good', quantity: 5, price: 200 },
      ]);
    });

    it("action='create' з rawBrand: резолвить наявний бренд → передає brandId, НЕ створює бренд", async () => {
      brandsService.resolveByNameOrSynonym.mockResolvedValueOnce({ id: 'brand-x' });
      goodsService.create.mockResolvedValueOnce({ id: 'ng' });
      await service.applyImport(ORG, 'PURCHASE_ORDER', 'doc-1', [
        {
          rowIndex: 2,
          action: 'create',
          createData: { name: 'T', rawBrand: 'Bosch' },
          quantity: 1,
          price: 10,
        },
      ]);
      expect(brandsService.create).not.toHaveBeenCalled();
      expect(goodsService.create.mock.calls[0]![1]).toMatchObject({ brandId: 'brand-x' });
    });

    it("action='create' з новим rawBrand: створює бренд коли не резолвиться", async () => {
      brandsService.resolveByNameOrSynonym.mockResolvedValueOnce(null);
      brandsService.create.mockResolvedValueOnce({ id: 'brand-new' });
      goodsService.create.mockResolvedValueOnce({ id: 'ng' });
      await service.applyImport(ORG, 'PURCHASE_ORDER', 'doc-1', [
        {
          rowIndex: 2,
          action: 'create',
          createData: { name: 'T', rawBrand: 'НовийБренд' },
          quantity: 1,
          price: 10,
        },
      ]);
      expect(brandsService.create).toHaveBeenCalledWith(ORG, { name: 'НовийБренд' });
      expect(goodsService.create.mock.calls[0]![1]).toMatchObject({ brandId: 'brand-new' });
    });

    it('Bug #748: дублікат goodId у межах імпорту → одна лінія (перше входження), не задвоєна кількість', async () => {
      // Два різні артикули резолвляться у ТОЙ САМИЙ товар g-1 (action=use двічі).
      prisma.good.findFirst.mockResolvedValue({ id: 'g-1' });
      await service.applyImport(ORG, 'PURCHASE_ORDER', 'doc-1', [
        { rowIndex: 2, action: 'use', goodId: 'g-1', quantity: 3, price: 100 },
        { rowIndex: 3, action: 'use', goodId: 'g-1', quantity: 5, price: 120 },
      ]);
      // Лише ОДНА лінія (перше входження) — без дедупу було б дві лінії на той самий goodId
      // без @@unique(docId,goodId) → задвоєна кількість/сума документа.
      expect(adapter.replaceLines.mock.calls[0]![3]).toEqual([
        { goodId: 'g-1', quantity: 3, price: 100 },
      ]);
    });

    it('Bug #748: use + create того ж наявного товару → дедуп після резолву', async () => {
      // create резолвить бренд→ні, створює good з id 'g-dup'; далі use того ж 'g-dup'.
      goodsService.create.mockResolvedValueOnce({ id: 'g-dup' });
      prisma.good.findFirst.mockResolvedValueOnce({ id: 'g-dup' });
      await service.applyImport(ORG, 'PURCHASE_ORDER', 'doc-1', [
        {
          rowIndex: 2,
          action: 'create',
          createData: { name: 'Товар', sku: 'DUP-1' },
          quantity: 2,
          price: 50,
        },
        { rowIndex: 3, action: 'use', goodId: 'g-dup', quantity: 4, price: 60 },
      ]);
      expect(adapter.replaceLines.mock.calls[0]![3]).toEqual([
        { goodId: 'g-dup', quantity: 2, price: 50 },
      ]);
    });

    it('replaceLines виконується всередині $transaction', async () => {
      prisma.good.findFirst.mockResolvedValueOnce({ id: 'g-1' });
      await service.applyImport(ORG, 'STOCK_DOCUMENT', 'doc-1', [
        { rowIndex: 2, action: 'use', goodId: 'g-1', quantity: 1, price: 10 },
      ]);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(adapter.replaceLines).toHaveBeenCalledTimes(1);
    });

    // ── Режим replace/append ──
    it('mode не передано → replace (backward-compat для наявних викликів)', async () => {
      prisma.good.findFirst.mockResolvedValueOnce({ id: 'g-1' });
      await service.applyImport(ORG, 'STOCK_DOCUMENT', 'doc-1', [
        { rowIndex: 2, action: 'use', goodId: 'g-1', quantity: 1, price: 10 },
      ]);
      expect(adapter.replaceLines).toHaveBeenCalledTimes(1);
      expect(adapter.appendLines).not.toHaveBeenCalled();
    });

    it("mode='replace' → replaceLines, appendLines не чіпаємо", async () => {
      prisma.good.findFirst.mockResolvedValueOnce({ id: 'g-1' });
      await service.applyImport(
        ORG,
        'STOCK_DOCUMENT',
        'doc-1',
        [{ rowIndex: 2, action: 'use', goodId: 'g-1', quantity: 1, price: 10 }],
        'user-1',
        'replace',
      );
      expect(adapter.replaceLines).toHaveBeenCalledTimes(1);
      expect(adapter.appendLines).not.toHaveBeenCalled();
    });

    it("mode='append' → appendLines, наявні рядки НЕ видаляються", async () => {
      prisma.good.findFirst.mockResolvedValueOnce({ id: 'g-1' });
      await service.applyImport(
        ORG,
        'STOCK_DOCUMENT',
        'doc-1',
        [{ rowIndex: 2, action: 'use', goodId: 'g-1', quantity: 3, price: 25 }],
        'user-1',
        'append',
      );
      expect(adapter.appendLines).toHaveBeenCalledTimes(1);
      expect(adapter.replaceLines).not.toHaveBeenCalled();
      expect(adapter.appendLines).toHaveBeenCalledWith(
        expect.anything(),
        ORG,
        'doc-1',
        [{ goodId: 'g-1', quantity: 3, price: 25 }],
        'user-1',
      );
    });
  });
});
