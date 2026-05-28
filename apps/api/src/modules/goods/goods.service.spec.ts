import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { GoodsService } from './goods.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Bug #162: unit-покриття goods.service.
 * Фокус — Bug #161: org-scoped FK-валідація brandId / unitId / preferredSupplierId
 * (cross-tenant leak + неінформативна P2003) + базові SKU-conflict / soft-delete кейси.
 */
describe('GoodsService', () => {
  let service: GoodsService;
  let prisma: {
    good: { findFirst: any; findMany: any; count: any; create: any; update: any };
    brand: { findFirst: any };
    unitOfMeasure: { findFirst: any };
    counterparty: { findFirst: any };
    $transaction: ReturnType<typeof vi.fn>;
  };

  const goodRow = {
    id: 'good-1', orgId: 'org-1', sku: 'OIL', name: 'Олива', unit: 'шт',
    unitId: null, brandId: null,
    purchasePrice: new Prisma.Decimal(100), salePrice: new Prisma.Decimal(150),
    category: null, barcode: null, notes: null, goodType: null,
    preferredSupplierId: null, preferredSupplier: null,
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
  };

  beforeEach(async () => {
    prisma = {
      good: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn().mockResolvedValue(goodRow),
        update: vi.fn().mockResolvedValue(goodRow),
      },
      brand: { findFirst: vi.fn() },
      unitOfMeasure: { findFirst: vi.fn() },
      counterparty: { findFirst: vi.fn() },
      $transaction: vi.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [GoodsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(GoodsService);
  });

  describe('findOne', () => {
    it('кидає NotFoundException якщо товар не знайдено в org', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(null);
      await expect(service.findOne('org-1', 'good-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create', () => {
    it('створює товар коли FK не передані (happy path)', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(null); // SKU check
      const res = await service.create('org-1', { name: 'Олива', salePrice: 150 });
      expect(res.id).toBe('good-1');
      expect(prisma.good.create).toHaveBeenCalledTimes(1);
    });

    it('кидає ConflictException при дублі SKU', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(goodRow); // SKU exists
      await expect(
        service.create('org-1', { name: 'Олива', salePrice: 150, sku: 'OIL' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.good.create).not.toHaveBeenCalled();
    });

    it('Bug #161: brandId з іншої org / неіснуючий → BadRequestException', async () => {
      prisma.brand.findFirst.mockResolvedValueOnce(null); // brand not in org
      await expect(
        service.create('org-1', { name: 'Олива', salePrice: 150, brandId: '11111111-1111-4111-8111-111111111111' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.good.create).not.toHaveBeenCalled();
    });

    it('Bug #161: unitId з іншої org / неіснуючий → BadRequestException', async () => {
      prisma.unitOfMeasure.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.create('org-1', { name: 'Олива', salePrice: 150, unitId: '22222222-2222-4222-8222-222222222222' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.good.create).not.toHaveBeenCalled();
    });

    it('Bug #161: preferredSupplierId з іншої org / неіснуючий → BadRequestException', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.create('org-1', { name: 'Олива', salePrice: 150, preferredSupplierId: '33333333-3333-4333-8333-333333333333' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.good.create).not.toHaveBeenCalled();
    });

    it('Bug #161: валідний org-scoped FK проходить і викликає create', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(null); // SKU not used (no sku in dto → skipped anyway)
      prisma.brand.findFirst.mockResolvedValueOnce({ id: 'brand-1' });
      prisma.unitOfMeasure.findFirst.mockResolvedValueOnce({ id: 'unit-1' });
      await service.create('org-1', {
        name: 'Олива', salePrice: 150,
        brandId: '11111111-1111-4111-8111-111111111111',
        unitId: '22222222-2222-4222-8222-222222222222',
      });
      expect(prisma.brand.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ orgId: 'org-1', deletedAt: null }) }),
      );
      expect(prisma.good.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('оновлює товар коли FK не передані', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(goodRow); // findOne
      const res = await service.update('org-1', 'good-1', { name: 'Нова назва' });
      expect(res.id).toBe('good-1');
      expect(prisma.good.update).toHaveBeenCalledTimes(1);
    });

    it('Bug #161: update з чужим brandId → BadRequestException, без update', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(goodRow); // findOne OK
      prisma.brand.findFirst.mockResolvedValueOnce(null); // brand not in org
      await expect(
        service.update('org-1', 'good-1', { brandId: '11111111-1111-4111-8111-111111111111' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.good.update).not.toHaveBeenCalled();
    });
  });
});
