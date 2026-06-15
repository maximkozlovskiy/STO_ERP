import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { XlsxService } from './xlsx.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PricingService } from '../inventory/pricing.service';

// Bug #188: regression-захист для applyPricingFromList + generatePricingListTemplate
describe('XlsxService', () => {
  let service: XlsxService;
  let prisma: {
    good: { findMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    priceHistory: {
      create: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };
  // Bulk-перехід: applyPricingFromList тепер prefetch-ить goods batch-ом і правила один раз
  // (computePriceFromRules — pure синхронний). У тестах мокаємо обидві операції.
  let pricingService: {
    getActiveRulesForOrg: ReturnType<typeof vi.fn>;
    computePriceFromRules: ReturnType<typeof vi.fn>;
    calculateSalePrice: ReturnType<typeof vi.fn>;
  };

  const ORG = 'org-1';

  beforeEach(async () => {
    prisma = {
      good: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      priceHistory: {
        create: vi.fn().mockResolvedValue({}),
        // sto-optimize: applyPricingFromList тепер батчить changes по 100 у єдиний
        // $transaction з priceHistory.createMany замість per-item create.
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
    };
    pricingService = {
      getActiveRulesForOrg: vi.fn().mockResolvedValue([]),
      computePriceFromRules: vi.fn(),
      calculateSalePrice: vi.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        XlsxService,
        { provide: PrismaService, useValue: prisma },
        { provide: PricingService, useValue: pricingService },
      ],
    }).compile();
    service = module.get(XlsxService);
  });

  // ─── generatePricingListTemplate ────────────────────────────────────────────

  describe('generatePricingListTemplate', () => {
    it('повертає Buffer з BOM + header + 2 sample-рядки', () => {
      const buf = service.generatePricingListTemplate();
      expect(Buffer.isBuffer(buf)).toBe(true);
      const text = buf.toString('utf-8');
      expect(text.charCodeAt(0)).toBe(0xfeff); // BOM
      const lines = text.replace(/^﻿/, '').trim().split('\n');
      expect(lines[0]).toBe('sku,barcode,name');
      expect(lines).toHaveLength(3); // header + 2 sample
      expect(lines[1]).toContain('OIL-5W40');
      expect(lines[2]).toContain('4820123456789');
    });
  });

  // ─── applyPricingFromList ───────────────────────────────────────────────────

  describe('applyPricingFromList — CSV', () => {
    it('парсить CSV з BOM + знаходить good по sku → пише $transaction', async () => {
      const csv = '﻿sku,barcode,name\nOIL-5W40,,Масло\n';
      const buffer = Buffer.from(csv, 'utf-8');

      prisma.good.findMany.mockResolvedValueOnce([
        {
          id: 'good-1',
          name: 'Масло',
          sku: 'OIL-5W40',
          purchasePrice: 100,
          salePrice: 130,
          category: null,
          goodType: 'CONSUMABLE',
          brandId: null,
          barcodes: [],
        },
      ]);
      pricingService.computePriceFromRules.mockReturnValueOnce(150);

      const result = await service.applyPricingFromList(ORG, buffer, 'csv');

      expect(result.found).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.notFound).toEqual([]);
      expect(result.details).toHaveLength(1);
      expect(result.details[0]).toMatchObject({
        goodId: 'good-1',
        sku: 'OIL-5W40',
        costPrice: 100,
        oldSalePrice: 130,
        newSalePrice: 150,
      });

      // Bug #191: updateMany з orgId
      expect(prisma.good.updateMany).toHaveBeenCalledWith({
        where: { id: 'good-1', orgId: ORG, deletedAt: null },
        data: { salePrice: 150 },
      });
      // sto-optimize: батч createMany замість per-item create
      expect(prisma.priceHistory.createMany).toHaveBeenCalled();
    });

    it('розпізнає alternative CSV headers (SKU, Артикул, Штрихкод)', async () => {
      const csv = 'Артикул,Штрихкод,name\nOIL-5W40,4820123456789,Масло\n';
      const buffer = Buffer.from(csv, 'utf-8');

      prisma.good.findMany.mockResolvedValueOnce([
        {
          id: 'good-1',
          name: 'Масло',
          sku: 'OIL-5W40',
          purchasePrice: 100,
          salePrice: 130,
          category: null,
          goodType: null,
          brandId: null,
          barcodes: [{ barcode: '4820123456789' }],
        },
      ]);
      pricingService.computePriceFromRules.mockReturnValueOnce(150);

      const result = await service.applyPricingFromList(ORG, buffer, 'csv');
      expect(result.found).toBe(1);
      // Bulk lookup: ОБИДВА варіанти (sku IN АБО barcodes IN) у одному findMany.
      // Perf: select narrow projection — Brand record unused (only brandId scalar read).
      expect(prisma.good.findMany).toHaveBeenCalledWith({
        where: {
          orgId: ORG,
          deletedAt: null,
          OR: [
            { sku: { in: ['OIL-5W40'] } },
            { barcodes: { some: { barcode: { in: ['4820123456789'] } } } },
          ],
        },
        select: {
          id: true,
          name: true,
          sku: true,
          salePrice: true,
          purchasePrice: true,
          category: true,
          goodType: true,
          brandId: true,
          barcodes: { select: { barcode: true } },
        },
        take: 10000,
      });
    });

    it('товар не знайдено → потрапляє у notFound[], не пише good.updateMany', async () => {
      const csv = 'sku,barcode,name\nUNKNOWN-SKU,,Невідомо\n';
      const buffer = Buffer.from(csv, 'utf-8');

      prisma.good.findMany.mockResolvedValueOnce([]);

      const result = await service.applyPricingFromList(ORG, buffer, 'csv');
      expect(result.found).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.notFound).toEqual(['UNKNOWN-SKU']);
      expect(prisma.good.updateMany).not.toHaveBeenCalled();
      expect(prisma.priceHistory.createMany).not.toHaveBeenCalled();
    });

    it('ціна не змінилась → у details АЛЕ не пише good.updateMany/priceHistory', async () => {
      const csv = 'sku,barcode,name\nOIL,,Масло\n';
      const buffer = Buffer.from(csv, 'utf-8');

      prisma.good.findMany.mockResolvedValueOnce([
        {
          id: 'good-1',
          name: 'Масло',
          sku: 'OIL',
          purchasePrice: 100,
          salePrice: 130,
          category: null,
          goodType: null,
          brandId: null,
          barcodes: [],
        },
      ]);
      pricingService.computePriceFromRules.mockReturnValueOnce(130); // no change

      const result = await service.applyPricingFromList(ORG, buffer, 'csv');
      expect(result.found).toBe(1);
      expect(result.updated).toBe(0); // skip count
      expect(result.details).toHaveLength(1); // запис у details ДЛЯ unchanged теж
      expect(prisma.good.updateMany).not.toHaveBeenCalled();
      expect(prisma.priceHistory.createMany).not.toHaveBeenCalled();
    });

    it('порожній CSV (тільки header) → BadRequestException', async () => {
      const csv = 'sku,barcode,name\n';
      const buffer = Buffer.from(csv, 'utf-8');
      await expect(service.applyPricingFromList(ORG, buffer, 'csv')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('CSV з рядками без sku та barcode → відфільтрується → BadRequestException', async () => {
      const csv = 'sku,barcode,name\n,,Лише назва\n';
      const buffer = Buffer.from(csv, 'utf-8');
      await expect(service.applyPricingFromList(ORG, buffer, 'csv')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('Bug #198: purchasePrice=null → потрапляє у notFound, не пише good.updateMany (захист від затирання salePrice=0)', async () => {
      const csv = 'sku,barcode,name\nNO-COST-SKU,,Без собівартості\n';
      const buffer = Buffer.from(csv, 'utf-8');

      prisma.good.findMany.mockResolvedValueOnce([
        {
          id: 'good-no-cost',
          name: 'Без собівартості',
          sku: 'NO-COST-SKU',
          purchasePrice: null,
          salePrice: 200,
          category: null,
          goodType: null,
          brandId: null,
          barcodes: [],
        },
      ]);

      const result = await service.applyPricingFromList(ORG, buffer, 'csv');
      expect(result.found).toBe(0); // не пушаємо у details
      expect(result.updated).toBe(0);
      expect(result.notFound).toEqual([expect.stringContaining('NO-COST-SKU')]);
      expect(result.notFound[0]).toContain('без собівартості');
      // computePriceFromRules НЕ викликаний — щоб не марнувати compute
      expect(pricingService.computePriceFromRules).not.toHaveBeenCalled();
      expect(prisma.good.updateMany).not.toHaveBeenCalled();
      expect(prisma.priceHistory.createMany).not.toHaveBeenCalled();
    });

    it('Bug #198: purchasePrice=0 → потрапляє у notFound (захист від PERCENT/COST_TIER 0%-результату)', async () => {
      const csv = 'sku,barcode,name\nZERO-COST,,Нуль собівартість\n';
      const buffer = Buffer.from(csv, 'utf-8');

      prisma.good.findMany.mockResolvedValueOnce([
        {
          id: 'good-zero',
          name: 'Нуль',
          sku: 'ZERO-COST',
          purchasePrice: 0,
          salePrice: 200,
          category: null,
          goodType: null,
          brandId: null,
          barcodes: [],
        },
      ]);

      const result = await service.applyPricingFromList(ORG, buffer, 'csv');
      expect(result.found).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.notFound).toEqual([expect.stringContaining('ZERO-COST')]);
      expect(pricingService.computePriceFromRules).not.toHaveBeenCalled();
      expect(prisma.good.updateMany).not.toHaveBeenCalled();
    });

    // Bug #489: regression-guard для deduplicateBy(plan, u => u.goodId) у applyPricingFromList.
    // CSV може мати ДУБЛЬОВАНИЙ SKU (користувач випадково або з різними barcode-ами для одного
    // SKU). goodBySku.get() повертає той самий good для обох рядків → plan має 2 entries з тим
    // же goodId але різними newSalePrice (бо computePriceFromRules може вернути різні значення
    // якщо є кілька правил). Без dedup Promise.all зробив би 2 writes на той самий PK → race.
    // dedupedPlan робить last-wins → updateMany викликається РІВНО РАЗ.
    it('Bug #489: дублікати SKU у CSV → updateMany викликається ОДИН раз для одного goodId (last-wins)', async () => {
      // Дві рядки з тим же SKU у CSV
      const csv = 'sku,barcode,name\nDUP-SKU,,X\nDUP-SKU,,X\n';
      const buffer = Buffer.from(csv, 'utf-8');

      prisma.good.findMany.mockResolvedValueOnce([
        {
          id: 'good-dup',
          name: 'Multi-row',
          sku: 'DUP-SKU',
          purchasePrice: 100,
          salePrice: 130,
          category: null,
          goodType: null,
          brandId: null,
          barcodes: [],
        },
      ]);
      // computePriceFromRules викликається ДВІЧІ — повертає різні значення (last-wins у БД)
      pricingService.computePriceFromRules
        .mockReturnValueOnce(150) // перша ітерація
        .mockReturnValueOnce(180); // друга ітерація — last-wins у БД через deduplicateBy

      const result = await service.applyPricingFromList(ORG, buffer, 'csv');

      // result.found/updated підраховуються з details (не deduped) — інформаційно для UI
      expect(result.found).toBe(2);
      expect(result.updated).toBe(2);
      // КРИТИЧНИЙ assert: updateMany викликається РІВНО РАЗ для дубльованого goodId
      // (без deduplicateBy → 2 writes на той самий PK → Promise.all race).
      expect(prisma.good.updateMany).toHaveBeenCalledTimes(1);
      // last-wins: остання обчислена ціна (180) перемагає у БД
      expect(prisma.good.updateMany).toHaveBeenCalledWith({
        where: { id: 'good-dup', orgId: ORG, deletedAt: null },
        data: { salePrice: 180 },
      });
    });

    it('updated лічильник правильний при mixed змінах (1 змінилась, 1 ні)', async () => {
      const csv = 'sku,barcode,name\nA-SKU,,A\nB-SKU,,B\n';
      const buffer = Buffer.from(csv, 'utf-8');

      prisma.good.findMany.mockResolvedValueOnce([
        {
          id: 'g-a',
          name: 'A',
          sku: 'A-SKU',
          purchasePrice: 100,
          salePrice: 150,
          category: null,
          goodType: null,
          brandId: null,
          barcodes: [],
        },
        {
          id: 'g-b',
          name: 'B',
          sku: 'B-SKU',
          purchasePrice: 50,
          salePrice: 70,
          category: null,
          goodType: null,
          brandId: null,
          barcodes: [],
        },
      ]);
      pricingService.computePriceFromRules
        .mockReturnValueOnce(150) // no change for A
        .mockReturnValueOnce(85); // change for B

      const result = await service.applyPricingFromList(ORG, buffer, 'csv');
      expect(result.found).toBe(2);
      expect(result.updated).toBe(1);
      expect(prisma.good.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.good.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'g-b' }) }),
      );
    });
  });

  describe('applyPricingFromList — XLSX', () => {
    it('парсить XLSX worksheet з колонками sku/barcode/name → знаходить good', async () => {
      // Build XLSX in-memory
      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet('list');
      sheet.addRow(['sku', 'barcode', 'name']);
      sheet.addRow(['OIL-5W40', '', 'Масло']);
      const buf = await wb.xlsx.writeBuffer();

      prisma.good.findMany.mockResolvedValueOnce([
        {
          id: 'good-1',
          name: 'Масло',
          sku: 'OIL-5W40',
          purchasePrice: 100,
          salePrice: 130,
          category: null,
          goodType: null,
          brandId: null,
          barcodes: [],
        },
      ]);
      pricingService.computePriceFromRules.mockReturnValueOnce(150);

      const result = await service.applyPricingFromList(ORG, buf as Buffer, 'xlsx');
      expect(result.found).toBe(1);
      expect(result.updated).toBe(1);
      expect(prisma.good.updateMany).toHaveBeenCalledTimes(1);
    });

    it('порожній XLSX → BadRequestException', async () => {
      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet('list');
      sheet.addRow(['sku', 'barcode', 'name']);
      const buf = await wb.xlsx.writeBuffer();

      await expect(service.applyPricingFromList(ORG, buf as Buffer, 'xlsx')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
