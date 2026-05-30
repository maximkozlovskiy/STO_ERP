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
    good: { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    priceHistory: { create: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let pricingService: { calculateSalePrice: ReturnType<typeof vi.fn> };

  const ORG = 'org-1';

  beforeEach(async () => {
    prisma = {
      good: {
        findFirst: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      priceHistory: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
    };
    pricingService = { calculateSalePrice: vi.fn() };

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
      expect(text.charCodeAt(0)).toBe(0xFEFF); // BOM
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

      prisma.good.findFirst.mockResolvedValueOnce({
        id: 'good-1', name: 'Масло', sku: 'OIL-5W40',
        purchasePrice: 100, salePrice: 130,
        category: null, goodType: 'CONSUMABLE', brandId: null,
      });
      pricingService.calculateSalePrice.mockResolvedValueOnce(150);

      const result = await service.applyPricingFromList(ORG, buffer, 'csv');

      expect(result.found).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.notFound).toEqual([]);
      expect(result.details).toHaveLength(1);
      expect(result.details[0]).toMatchObject({
        goodId: 'good-1', sku: 'OIL-5W40', costPrice: 100, oldSalePrice: 130, newSalePrice: 150,
      });

      // Bug #191: updateMany з orgId
      expect(prisma.good.updateMany).toHaveBeenCalledWith({
        where: { id: 'good-1', orgId: ORG, deletedAt: null },
        data: { salePrice: 150 },
      });
      expect(prisma.priceHistory.create).toHaveBeenCalled();
    });

    it('розпізнає alternative CSV headers (SKU, Артикул, Штрихкод)', async () => {
      const csv = 'Артикул,Штрихкод,name\nOIL-5W40,4820123456789,Масло\n';
      const buffer = Buffer.from(csv, 'utf-8');

      prisma.good.findFirst.mockResolvedValueOnce({
        id: 'good-1', name: 'Масло', sku: 'OIL-5W40',
        purchasePrice: 100, salePrice: 130,
        category: null, goodType: null, brandId: null,
      });
      pricingService.calculateSalePrice.mockResolvedValueOnce(150);

      const result = await service.applyPricingFromList(ORG, buffer, 'csv');
      expect(result.found).toBe(1);
      // Перевіряємо що where має ОБИДВА варіанти (sku АБО barcode relation)
      expect(prisma.good.findFirst).toHaveBeenCalledWith({
        where: {
          orgId: ORG,
          deletedAt: null,
          OR: [
            { sku: 'OIL-5W40' },
            { barcodes: { some: { barcode: '4820123456789' } } },
          ],
        },
        include: { brand: true },
      });
    });

    it('товар не знайдено → потрапляє у notFound[], не пише good.updateMany', async () => {
      const csv = 'sku,barcode,name\nUNKNOWN-SKU,,Невідомо\n';
      const buffer = Buffer.from(csv, 'utf-8');

      prisma.good.findFirst.mockResolvedValueOnce(null);

      const result = await service.applyPricingFromList(ORG, buffer, 'csv');
      expect(result.found).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.notFound).toEqual(['UNKNOWN-SKU']);
      expect(prisma.good.updateMany).not.toHaveBeenCalled();
      expect(prisma.priceHistory.create).not.toHaveBeenCalled();
    });

    it('ціна не змінилась → у details АЛЕ не пише good.updateMany/priceHistory', async () => {
      const csv = 'sku,barcode,name\nOIL,,Масло\n';
      const buffer = Buffer.from(csv, 'utf-8');

      prisma.good.findFirst.mockResolvedValueOnce({
        id: 'good-1', name: 'Масло', sku: 'OIL',
        purchasePrice: 100, salePrice: 130,
        category: null, goodType: null, brandId: null,
      });
      pricingService.calculateSalePrice.mockResolvedValueOnce(130); // no change

      const result = await service.applyPricingFromList(ORG, buffer, 'csv');
      expect(result.found).toBe(1);
      expect(result.updated).toBe(0); // skip count
      expect(result.details).toHaveLength(1); // запис у details ДЛЯ unchanged теж
      expect(prisma.good.updateMany).not.toHaveBeenCalled();
      expect(prisma.priceHistory.create).not.toHaveBeenCalled();
    });

    it('порожній CSV (тільки header) → BadRequestException', async () => {
      const csv = 'sku,barcode,name\n';
      const buffer = Buffer.from(csv, 'utf-8');
      await expect(service.applyPricingFromList(ORG, buffer, 'csv'))
        .rejects.toThrow(BadRequestException);
    });

    it('CSV з рядками без sku та barcode → відфільтрується → BadRequestException', async () => {
      const csv = 'sku,barcode,name\n,,Лише назва\n';
      const buffer = Buffer.from(csv, 'utf-8');
      await expect(service.applyPricingFromList(ORG, buffer, 'csv'))
        .rejects.toThrow(BadRequestException);
    });

    it('Bug #198: purchasePrice=null → потрапляє у notFound, не пише good.updateMany (захист від затирання salePrice=0)', async () => {
      const csv = 'sku,barcode,name\nNO-COST-SKU,,Без собівартості\n';
      const buffer = Buffer.from(csv, 'utf-8');

      prisma.good.findFirst.mockResolvedValueOnce({
        id: 'good-no-cost', name: 'Без собівартості', sku: 'NO-COST-SKU',
        purchasePrice: null, salePrice: 200,
        category: null, goodType: null, brandId: null,
      });

      const result = await service.applyPricingFromList(ORG, buffer, 'csv');
      expect(result.found).toBe(0); // не пушаємо у details
      expect(result.updated).toBe(0);
      expect(result.notFound).toEqual([expect.stringContaining('NO-COST-SKU')]);
      expect(result.notFound[0]).toContain('без собівартості');
      // calculateSalePrice НЕ викликаний — щоб не марнувати query
      expect(pricingService.calculateSalePrice).not.toHaveBeenCalled();
      expect(prisma.good.updateMany).not.toHaveBeenCalled();
      expect(prisma.priceHistory.create).not.toHaveBeenCalled();
    });

    it('Bug #198: purchasePrice=0 → потрапляє у notFound (захист від PERCENT/COST_TIER 0%-результату)', async () => {
      const csv = 'sku,barcode,name\nZERO-COST,,Нуль собівартість\n';
      const buffer = Buffer.from(csv, 'utf-8');

      prisma.good.findFirst.mockResolvedValueOnce({
        id: 'good-zero', name: 'Нуль', sku: 'ZERO-COST',
        purchasePrice: 0, salePrice: 200,
        category: null, goodType: null, brandId: null,
      });

      const result = await service.applyPricingFromList(ORG, buffer, 'csv');
      expect(result.found).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.notFound).toEqual([expect.stringContaining('ZERO-COST')]);
      expect(pricingService.calculateSalePrice).not.toHaveBeenCalled();
      expect(prisma.good.updateMany).not.toHaveBeenCalled();
    });

    it('updated лічильник правильний при mixed змінах (1 змінилась, 1 ні)', async () => {
      const csv = 'sku,barcode,name\nA-SKU,,A\nB-SKU,,B\n';
      const buffer = Buffer.from(csv, 'utf-8');

      prisma.good.findFirst
        .mockResolvedValueOnce({ id: 'g-a', name: 'A', sku: 'A-SKU', purchasePrice: 100, salePrice: 150, category: null, goodType: null, brandId: null })
        .mockResolvedValueOnce({ id: 'g-b', name: 'B', sku: 'B-SKU', purchasePrice: 50,  salePrice: 70,  category: null, goodType: null, brandId: null });
      pricingService.calculateSalePrice
        .mockResolvedValueOnce(150) // no change for A
        .mockResolvedValueOnce(85); // change for B

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

      prisma.good.findFirst.mockResolvedValueOnce({
        id: 'good-1', name: 'Масло', sku: 'OIL-5W40',
        purchasePrice: 100, salePrice: 130,
        category: null, goodType: null, brandId: null,
      });
      pricingService.calculateSalePrice.mockResolvedValueOnce(150);

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

      await expect(service.applyPricingFromList(ORG, buf as Buffer, 'xlsx'))
        .rejects.toThrow(BadRequestException);
    });
  });
});
