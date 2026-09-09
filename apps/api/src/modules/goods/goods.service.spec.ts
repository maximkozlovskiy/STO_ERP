import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { GoodsService } from './goods.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';

/**
 * Bug #162: unit-покриття goods.service.
 * Фокус — Bug #161: org-scoped FK-валідація brandId / unitId / preferredSupplierId
 * (cross-tenant leak + неінформативна P2003) + базові SKU-conflict / soft-delete кейси.
 */
describe('GoodsService', () => {
  let service: GoodsService;
  let prisma: {
    good: {
      findFirst: any;
      findFirstOrThrow: any;
      findMany: any;
      count: any;
      create: any;
      update: any;
      updateMany: any;
    };
    brand: { findFirst: any };
    unitOfMeasure: { findFirst: any };
    counterparty: { findFirst: any };
    goodUoM: {
      findFirst: any;
      findMany: any;
      count: any;
      create: any;
      update: any;
      updateMany: any;
      delete: any;
    };
    stockItem: { groupBy: any; findMany: any };
    $transaction: ReturnType<typeof vi.fn>;
  };
  // Bug #534: docNumbers.next mock — без нього DI Nest падає на compile усіх 30 тестів.
  // Bug #535: дозволяє асерти на виклик з 'GOOD_INTERNAL_CODE' у create-тестах.
  let docNumbersMock: { next: ReturnType<typeof vi.fn> };

  const goodRow = {
    id: 'good-1',
    orgId: 'org-1',
    internalCode: 'T-000001',
    sku: 'OIL',
    name: 'Олива',
    unit: 'шт',
    unitId: null,
    brandId: null,
    purchasePrice: new Prisma.Decimal(100),
    salePrice: new Prisma.Decimal(150),
    category: null,
    barcode: null,
    notes: null,
    goodType: null,
    preferredSupplierId: null,
    preferredSupplier: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };

  beforeEach(async () => {
    prisma = {
      good: {
        findFirst: vi.fn(),
        findFirstOrThrow: vi.fn().mockResolvedValue(goodRow),
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn().mockResolvedValue(goodRow),
        update: vi.fn().mockResolvedValue(goodRow),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      brand: { findFirst: vi.fn() },
      unitOfMeasure: { findFirst: vi.fn() },
      counterparty: { findFirst: vi.fn() },
      goodUoM: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        delete: vi.fn(),
      },
      // Bug #459: service.stockTotals() з commit 4a05d7c7 викликає БОТКИ
      // groupBy (агрегати) і findMany (per-warehouse breakdown) у Promise.all.
      stockItem: {
        groupBy: vi.fn().mockResolvedValue([]),
        findMany: vi.fn().mockResolvedValue([]),
        // A2: remove-guard шукає ненульовий залишок/резерв. За замовч. null (немає балансу).
        findFirst: vi.fn().mockResolvedValue(null),
      },
      $transaction: vi.fn(),
    };
    // Bug #534: docNumbers — нова DI у GoodsService constructor з commit 9ea58b9e.
    // Default повертає 'T-000001' відповідно seed.ts (prefix='T', padding=6).
    docNumbersMock = { next: vi.fn().mockResolvedValue('T-000001') };

    const module = await Test.createTestingModule({
      providers: [
        GoodsService,
        { provide: PrismaService, useValue: prisma },
        { provide: DocumentNumberService, useValue: docNumbersMock },
      ],
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
        service.create('org-1', {
          name: 'Олива',
          salePrice: 150,
          brandId: '11111111-1111-4111-8111-111111111111',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.good.create).not.toHaveBeenCalled();
    });

    it('Bug #161: unitId з іншої org / неіснуючий → BadRequestException', async () => {
      prisma.unitOfMeasure.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.create('org-1', {
          name: 'Олива',
          salePrice: 150,
          unitId: '22222222-2222-4222-8222-222222222222',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.good.create).not.toHaveBeenCalled();
    });

    it('Bug #161: preferredSupplierId з іншої org / неіснуючий → BadRequestException', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.create('org-1', {
          name: 'Олива',
          salePrice: 150,
          preferredSupplierId: '33333333-3333-4333-8333-333333333333',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.good.create).not.toHaveBeenCalled();
    });

    it('Bug #161: валідний org-scoped FK проходить і викликає create', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(null); // SKU not used (no sku in dto → skipped anyway)
      prisma.brand.findFirst.mockResolvedValueOnce({ id: 'brand-1' });
      prisma.unitOfMeasure.findFirst.mockResolvedValueOnce({ id: 'unit-1' });
      await service.create('org-1', {
        name: 'Олива',
        salePrice: 150,
        brandId: '11111111-1111-4111-8111-111111111111',
        unitId: '22222222-2222-4222-8222-222222222222',
      });
      expect(prisma.brand.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ orgId: 'org-1', deletedAt: null }),
        }),
      );
      expect(prisma.good.create).toHaveBeenCalledTimes(1);
    });
  });

  // MD-C1: restore не має воскрешати товар, якщо активний дубль SKU/internalCode вже існує
  // (SKU лише @@index, без DB-констрейнта → потрібен guard у сервісі, як у units/brands).
  describe('restore — SKU/internalCode conflict guard (MD-C1)', () => {
    it('кидає ConflictException коли активний товар з тим самим SKU існує', async () => {
      prisma.good.findFirst
        .mockResolvedValueOnce({ sku: 'OIL', internalCode: 'T-000001' }) // deleted good
        .mockResolvedValueOnce({ id: 'other-active' }); // active SKU clash
      await expect(service.restore('org-1', 'good-1')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.good.updateMany).not.toHaveBeenCalled();
    });

    it('відновлює коли конфлікту немає', async () => {
      prisma.good.findFirst
        .mockResolvedValueOnce({ sku: 'OIL', internalCode: 'T-000001' }) // deleted good
        .mockResolvedValueOnce(null) // no SKU clash
        .mockResolvedValueOnce(null); // no internalCode clash
      prisma.good.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.good.findFirstOrThrow.mockResolvedValueOnce(goodRow);
      const res = await service.restore('org-1', 'good-1');
      expect(res.id).toBe('good-1');
      expect(prisma.good.updateMany).toHaveBeenCalledTimes(1);
    });

    it('кидає NotFound коли видалений товар не знайдено', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(null);
      await expect(service.restore('org-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove — A2 soft-delete guard (ненульовий залишок)', () => {
    it('товар із ненульовим залишком/резервом → BadRequest, updateMany НЕ викликається', async () => {
      prisma.stockItem.findFirst.mockResolvedValueOnce({ id: 'si-1' }); // є баланс
      await expect(service.remove('org-1', 'good-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.good.updateMany).not.toHaveBeenCalled();
      // guard tenant-scoped + шукає quantity≠0 OR reserved≠0.
      const where = prisma.stockItem.findFirst.mock.calls[0][0].where;
      expect(where).toMatchObject({ orgId: 'org-1', goodId: 'good-1', deletedAt: null });
      expect(where.OR).toEqual([{ quantity: { not: 0 } }, { reserved: { not: 0 } }]);
      // MUTATION-VERIFY: прибрати guard → updateMany викликається → StockItem осиротіє на мертвий good.
    });

    it('товар без залишку → soft-delete проходить', async () => {
      prisma.stockItem.findFirst.mockResolvedValueOnce(null);
      prisma.good.updateMany.mockResolvedValueOnce({ count: 1 });
      await service.remove('org-1', 'good-1');
      expect(prisma.good.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  // Bug #535 (regression-guard для feat 9ea58b9e internalCode generation):
  // sanity для side-effect що `create()` отримує internalCode з DocumentNumberService
  // ТА що sequence НЕ споживається даремно при precheck-throw (SKU/FK conflicts).
  // SKILL §1.1 «Hardcoded document-number у auto-create» (Bug #348) + «нове enum
  // value без regression-guard» (Bug #478-#480) обидва вимагають такого spec.
  describe('create — internalCode generation (Bug #535)', () => {
    it('Bug #535: викликає docNumbers.next(orgId, "GOOD_INTERNAL_CODE") рівно 1 раз', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(null); // no SKU conflict
      await service.create('org-1', { name: 'Олива', salePrice: 150 });
      expect(docNumbersMock.next).toHaveBeenCalledTimes(1);
      expect(docNumbersMock.next).toHaveBeenCalledWith('org-1', 'GOOD_INTERNAL_CODE');
    });

    it('Bug #535: згенерований internalCode потрапляє у prisma.good.create.data', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(null);
      docNumbersMock.next.mockResolvedValueOnce('T-000042');
      await service.create('org-1', { name: 'Олива', salePrice: 150 });
      expect(prisma.good.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ internalCode: 'T-000042', orgId: 'org-1' }),
        }),
      );
    });

    it('Bug #535: повертає internalCode у GoodResponseDto', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(null);
      const res = await service.create('org-1', { name: 'Олива', salePrice: 150 });
      expect(res.internalCode).toBe('T-000001');
    });

    it('Bug #535: SKU-conflict → docNumbers.next НЕ викликається (seq не споживається)', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(goodRow); // SKU exists
      await expect(
        service.create('org-1', { name: 'Олива', salePrice: 150, sku: 'OIL' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(docNumbersMock.next).not.toHaveBeenCalled();
      expect(prisma.good.create).not.toHaveBeenCalled();
    });

    it('Bug #535: brand-FK fail → docNumbers.next НЕ викликається', async () => {
      prisma.brand.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.create('org-1', {
          name: 'Олива',
          salePrice: 150,
          brandId: '11111111-1111-4111-8111-111111111111',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(docNumbersMock.next).not.toHaveBeenCalled();
      expect(prisma.good.create).not.toHaveBeenCalled();
    });

    it('Bug #535: unit-FK fail → docNumbers.next НЕ викликається', async () => {
      prisma.unitOfMeasure.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.create('org-1', {
          name: 'Олива',
          salePrice: 150,
          unitId: '22222222-2222-4222-8222-222222222222',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(docNumbersMock.next).not.toHaveBeenCalled();
      expect(prisma.good.create).not.toHaveBeenCalled();
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

  // ──────────────────────────────────────────────────────────────────────────
  // Bug #228: UoM CRUD unit coverage (addUoM/setDefaultUoM/removeUoM).
  // Covers: tenant + soft-delete (#223), defense-in-depth (#224), TOCTOU
  // P2002 mapping (#225), promotion-on-delete invariant.
  // ──────────────────────────────────────────────────────────────────────────

  const unitRow = {
    id: 'unit-1',
    orgId: 'org-1',
    name: 'Літр',
    shortName: 'л',
    coefficient: 1,
  };
  const uomRow = {
    id: 'uom-1',
    orgId: 'org-1',
    goodId: 'good-1',
    unitOfMeasureId: 'unit-1',
    isDefault: false,
    createdAt: new Date('2026-01-01'),
    unitOfMeasure: { name: 'Літр', shortName: 'л', coefficient: 1 },
  };

  describe('addUoM', () => {
    it('1-ша UoM сетить isDefault=true і оновлює Good.unit/unitId', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(goodRow); // good lookup
      prisma.unitOfMeasure.findFirst.mockResolvedValueOnce(unitRow); // unit lookup
      prisma.goodUoM.findFirst.mockResolvedValueOnce(null); // no existing
      prisma.goodUoM.count.mockResolvedValueOnce(0); // first
      // $transaction(async tx) — emulate by calling the callback with prisma
      prisma.$transaction.mockImplementationOnce(async (cb: any) =>
        cb({
          goodUoM: {
            create: vi.fn().mockResolvedValueOnce({ ...uomRow, isDefault: true }),
            update: vi.fn(),
            updateMany: vi.fn(),
            findFirst: vi.fn(),
            delete: vi.fn(),
          },
          good: { updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }) },
        }),
      );

      const res = await service.addUoM('org-1', 'good-1', { unitOfMeasureId: 'unit-1' });
      expect(res.isDefault).toBe(true);
      expect(res.unitShortName).toBe('л');
    });

    it('N-та UoM не змінює default і не оновлює Good.unit', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(goodRow);
      prisma.unitOfMeasure.findFirst.mockResolvedValueOnce(unitRow);
      prisma.goodUoM.findFirst.mockResolvedValueOnce(null);
      prisma.goodUoM.count.mockResolvedValueOnce(2); // not first
      const goodUpdateMany = vi.fn();
      prisma.$transaction.mockImplementationOnce(async (cb: any) =>
        cb({
          goodUoM: {
            create: vi.fn().mockResolvedValueOnce({ ...uomRow, isDefault: false }),
            update: vi.fn(),
            updateMany: vi.fn(),
            findFirst: vi.fn(),
            delete: vi.fn(),
          },
          good: { updateMany: goodUpdateMany },
        }),
      );

      const res = await service.addUoM('org-1', 'good-1', { unitOfMeasureId: 'unit-1' });
      expect(res.isDefault).toBe(false);
      expect(goodUpdateMany).not.toHaveBeenCalled();
    });

    it('Bug #223: cross-tenant good (findFirst → null) → NotFoundException', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(null); // not in org
      prisma.unitOfMeasure.findFirst.mockResolvedValueOnce(unitRow);
      await expect(
        service.addUoM('org-1', 'good-1', { unitOfMeasureId: 'unit-1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('Bug #223: cross-tenant unit → NotFoundException', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(goodRow);
      prisma.unitOfMeasure.findFirst.mockResolvedValueOnce(null); // unit not in org
      await expect(
        service.addUoM('org-1', 'good-1', { unitOfMeasureId: 'unit-1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('existing UoM mapping → ConflictException, no create', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(goodRow);
      prisma.unitOfMeasure.findFirst.mockResolvedValueOnce(unitRow);
      prisma.goodUoM.findFirst.mockResolvedValueOnce(uomRow); // already exists
      await expect(
        service.addUoM('org-1', 'good-1', { unitOfMeasureId: 'unit-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('Bug #225: TOCTOU race → P2002 у create мапиться у ConflictException 409', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(goodRow);
      prisma.unitOfMeasure.findFirst.mockResolvedValueOnce(unitRow);
      prisma.goodUoM.findFirst.mockResolvedValueOnce(null);
      prisma.goodUoM.count.mockResolvedValueOnce(1);
      const p2002 = new Prisma.PrismaClientKnownRequestError('unique violation', {
        code: 'P2002',
        clientVersion: 'test',
      });
      prisma.$transaction.mockImplementationOnce(async () => {
        throw p2002;
      });
      await expect(
        service.addUoM('org-1', 'good-1', { unitOfMeasureId: 'unit-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('setDefaultUoM', () => {
    it('Bug #223: soft-deleted good → NotFoundException (findOne fails first)', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(null); // findOne → not found
      await expect(service.setDefaultUoM('org-1', 'good-1', 'uom-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('uom з чужої org → NotFoundException', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(goodRow); // good OK
      prisma.goodUoM.findFirst.mockResolvedValueOnce(null); // uom not in org/good
      await expect(service.setDefaultUoM('org-1', 'good-1', 'uom-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('happy path: всі поточні UoMs скидаються, target стає isDefault, Good.unit оновлюється', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(goodRow);
      prisma.goodUoM.findFirst.mockResolvedValueOnce(uomRow);
      prisma.$transaction.mockResolvedValueOnce([{ count: 3 }, uomRow, { count: 1 }]);

      const res = await service.setDefaultUoM('org-1', 'good-1', 'uom-1');
      expect(res.isDefault).toBe(true);
      // Verified that batch $transaction array form was called (3 ops)
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const ops = prisma.$transaction.mock.calls[0][0];
      expect(Array.isArray(ops)).toBe(true);
      expect(ops.length).toBe(3);
    });
  });

  describe('removeUoM', () => {
    it('Bug #223: soft-deleted good → NotFoundException', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(null);
      await expect(service.removeUoM('org-1', 'good-1', 'uom-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('total===1 → BadRequestException ("не можна видалити єдину...")', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(goodRow);
      prisma.goodUoM.findFirst.mockResolvedValueOnce(uomRow);
      prisma.goodUoM.count.mockResolvedValueOnce(1);
      await expect(service.removeUoM('org-1', 'good-1', 'uom-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('видалення non-default коли total>1 → транзакція виконується, без auto-promote', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(goodRow);
      prisma.goodUoM.findFirst.mockResolvedValueOnce({ ...uomRow, isDefault: false });
      prisma.goodUoM.count.mockResolvedValueOnce(2);
      const txFindFirst = vi.fn();
      const txUpdateMany = vi.fn();
      prisma.$transaction.mockImplementationOnce(async (cb: any) =>
        cb({
          goodUoM: {
            // Bug #277 (review cycle 5): hard delete переведено на deleteMany
            // з compound where (orgId+goodId guard) — defense-in-depth pattern 2026-05-30.
            deleteMany: vi.fn(),
            findFirst: txFindFirst,
            updateMany: txUpdateMany,
          },
          good: { updateMany: vi.fn() },
        }),
      );
      await service.removeUoM('org-1', 'good-1', 'uom-1');
      // No auto-promote — uom was not default
      expect(txFindFirst).not.toHaveBeenCalled();
      expect(txUpdateMany).not.toHaveBeenCalled();
    });

    it('видалення default коли total>1 → промотує наступний UoM (createdAt asc) у default + оновлює Good.unit', async () => {
      prisma.good.findFirst.mockResolvedValueOnce(goodRow);
      prisma.goodUoM.findFirst.mockResolvedValueOnce({ ...uomRow, isDefault: true });
      prisma.goodUoM.count.mockResolvedValueOnce(2);
      const txUpdateMany = vi.fn();
      const goodUpdateMany = vi.fn();
      const nextUom = {
        id: 'uom-2',
        unitOfMeasureId: 'unit-2',
        isDefault: false,
        unitOfMeasure: { shortName: 'кг', name: 'Кілограм', coefficient: 1 },
      };
      prisma.$transaction.mockImplementationOnce(async (cb: any) =>
        cb({
          goodUoM: {
            deleteMany: vi.fn(),
            findFirst: vi.fn().mockResolvedValueOnce(nextUom),
            updateMany: txUpdateMany,
          },
          good: { updateMany: goodUpdateMany },
        }),
      );
      await service.removeUoM('org-1', 'good-1', 'uom-1');
      // Next UoM was promoted via updateMany з compound where (orgId+goodId guard)
      expect(txUpdateMany).toHaveBeenCalledWith({
        where: { id: 'uom-2', orgId: 'org-1', goodId: 'good-1' },
        data: { isDefault: true },
      });
      // Good.unit synced to new default (defense-in-depth: updateMany w/ orgId)
      expect(goodUpdateMany).toHaveBeenCalledWith({
        where: { id: 'good-1', orgId: 'org-1', deletedAt: null },
        data: { unitId: 'unit-2', unit: 'кг' },
      });
    });
  });

  // Bug #452: regression-guard для /goods/stock-totals (фіча "К-ть на складі"
  // у CreateWorkOrderModal, додана commit 0618c621 + fix c0879445 — раніше без spec).
  describe('stockTotals', () => {
    it('Bug #452: порожній масив goodIds → повертає [] без запиту до БД', async () => {
      const res = await service.stockTotals('org-1', []);
      expect(res).toEqual([]);
      expect(prisma.stockItem.groupBy).not.toHaveBeenCalled();
    });

    it('Bug #452: query фільтрується по orgId + deletedAt: null (tenant isolation + soft-delete)', async () => {
      prisma.stockItem.groupBy.mockResolvedValueOnce([]);
      await service.stockTotals('org-1', ['g1', 'g2']);
      expect(prisma.stockItem.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['goodId'],
          where: { orgId: 'org-1', goodId: { in: ['g1', 'g2'] }, deletedAt: null },
          _sum: { quantity: true },
        }),
      );
    });

    it('Bug #452: SUM(quantity) за goodId по кільком складам — повертає агрегат', async () => {
      // g1 присутній на 2 складах (10 + 5 = 15), g2 на 1 (3)
      prisma.stockItem.groupBy.mockResolvedValueOnce([
        { goodId: 'g1', _sum: { quantity: 15 } },
        { goodId: 'g2', _sum: { quantity: 3 } },
      ]);
      const res = await service.stockTotals('org-1', ['g1', 'g2']);
      expect(res).toEqual([
        { goodId: 'g1', totalQuantity: 15, byWarehouse: [] },
        { goodId: 'g2', totalQuantity: 3, byWarehouse: [] },
      ]);
    });

    it('Bug #452: товар без StockItem → groupBy опускає bucket, повертається без нього (FE мапить у 0)', async () => {
      // g1 існує, g3 НЕ існує — groupBy опускає (нема рядків); FE сам fallback-ить у 0.
      prisma.stockItem.groupBy.mockResolvedValueOnce([{ goodId: 'g1', _sum: { quantity: 7 } }]);
      const res = await service.stockTotals('org-1', ['g1', 'g3']);
      expect(res).toEqual([{ goodId: 'g1', totalQuantity: 7, byWarehouse: [] }]);
      // g3 НЕ повертається — це навмисна семантика: FE pre-seed Map за всіма ids у 0.
      expect(res.find(r => r.goodId === 'g3')).toBeUndefined();
    });

    it('Bug #452: _sum.quantity = null (Prisma агрегат без рядків) → totalQuantity 0, не NaN', async () => {
      // Захист від крайового кейсу: якщо groupBy повертає bucket з _sum.quantity: null
      // (теоретично можливо при edge-кейсах WHERE), Number(null ?? 0) = 0, не NaN.
      prisma.stockItem.groupBy.mockResolvedValueOnce([{ goodId: 'g1', _sum: { quantity: null } }]);
      const res = await service.stockTotals('org-1', ['g1']);
      expect(res).toEqual([{ goodId: 'g1', totalQuantity: 0, byWarehouse: [] }]);
      expect(Number.isFinite(res[0].totalQuantity)).toBe(true);
    });

    it('Bug #459: byWarehouse breakdown — findMany повертає per-warehouse rows, мапиться у byWarehouse[]', async () => {
      // g1 присутній на 2 складах (wh-1: 10, wh-2: 5 = 15), g2 на 1 (wh-1: 3)
      prisma.stockItem.groupBy.mockResolvedValueOnce([
        { goodId: 'g1', _sum: { quantity: 15 } },
        { goodId: 'g2', _sum: { quantity: 3 } },
      ]);
      prisma.stockItem.findMany.mockResolvedValueOnce([
        { goodId: 'g1', warehouseId: 'wh-1', quantity: 10 },
        { goodId: 'g1', warehouseId: 'wh-2', quantity: 5 },
        { goodId: 'g2', warehouseId: 'wh-1', quantity: 3 },
      ]);
      const res = await service.stockTotals('org-1', ['g1', 'g2']);
      expect(res).toEqual([
        {
          goodId: 'g1',
          totalQuantity: 15,
          byWarehouse: [
            { warehouseId: 'wh-1', quantity: 10 },
            { warehouseId: 'wh-2', quantity: 5 },
          ],
        },
        { goodId: 'g2', totalQuantity: 3, byWarehouse: [{ warehouseId: 'wh-1', quantity: 3 }] },
      ]);
      // findMany застосовує ті ж guards: orgId, deletedAt: null, goodId IN [...]
      const findManyArgs = prisma.stockItem.findMany.mock.calls[0][0];
      expect(findManyArgs.where).toEqual({
        orgId: 'org-1',
        goodId: { in: ['g1', 'g2'] },
        deletedAt: null,
      });
      expect(findManyArgs.take).toBe(2000); // hard-cap проти OOM
    });

    it('Bug #452: НЕ повертає товар з іншої org (cross-tenant isolation)', async () => {
      // Сервіс просто додає orgId у where → якщо Prisma поверне 0 buckets, контрольно
      // перевіряємо що where містив правильний orgId. Спрощено: симулюємо що
      // запит від 'org-A' до товару 'g-from-org-B' повертає [] (немає StockItem).
      prisma.stockItem.groupBy.mockResolvedValueOnce([]);
      const res = await service.stockTotals('org-A', ['g-from-org-B']);
      expect(res).toEqual([]);
      const callArgs = prisma.stockItem.groupBy.mock.calls[0][0];
      expect(callArgs.where.orgId).toBe('org-A');
    });

    it('Bug #452: soft-deleted StockItem (deletedAt!=null) не включається в SUM', async () => {
      // Контракт сервісу: where { deletedAt: null }. Prisma фільтрує — повернеться 0.
      prisma.stockItem.groupBy.mockResolvedValueOnce([]);
      await service.stockTotals('org-1', ['g1']);
      const callArgs = prisma.stockItem.groupBy.mock.calls[0][0];
      expect(callArgs.where.deletedAt).toBeNull();
    });
  });

  // Сканер ШК: пошук товару включає додаткові ШК (GoodBarcode[]), не лише Good.barcode.
  describe('findAll — пошук за штрих-кодом', () => {
    const q = (partial: Record<string, unknown> = {}) =>
      ({ page: 1, limit: 20, ...partial }) as never;

    it('?q= шукає і по name/sku/barcode, і по barcodes[] (точний матч, orgId)', async () => {
      prisma.good.findMany.mockResolvedValueOnce([{ ...goodRow, barcodes: [{ barcode: '999' }] }]);
      prisma.good.count.mockResolvedValueOnce(1);
      const res = await service.findAll('org-1', q({ q: '999' }));
      const where = prisma.good.findMany.mock.calls[0][0].where;
      // OR має містити barcodes.some з orgId
      const hasBarcodesSome = (where.OR as Array<Record<string, unknown>>).some(
        c => 'barcodes' in c,
      );
      expect(hasBarcodesSome).toBe(true);
      // toDto віддає barcodes як string[]
      expect(res.items[0].barcodes).toEqual(['999']);
    });

    it('?barcode= (exact) шукає головний АБО додатковий ШК; фільтрує orgId', async () => {
      prisma.good.findMany.mockResolvedValueOnce([goodRow]);
      prisma.good.count.mockResolvedValueOnce(1);
      await service.findAll('org-1', q({ barcode: '4820000000012' }));
      const where = prisma.good.findMany.mock.calls[0][0].where;
      expect(where.orgId).toBe('org-1');
      expect(Array.isArray(where.OR)).toBe(true);
      // одна з гілок — головний barcode, інша — barcodes.some
      const branches = where.OR as Array<Record<string, unknown>>;
      expect(branches.some(b => b.barcode === '4820000000012')).toBe(true);
      expect(branches.some(b => 'barcodes' in b)).toBe(true);
    });

    it('include підтягує barcodes; toDto без barcodes → []', async () => {
      prisma.good.findMany.mockResolvedValueOnce([goodRow]); // без barcodes у row
      prisma.good.count.mockResolvedValueOnce(1);
      const res = await service.findAll('org-1', q({ q: 'олива' }));
      expect(prisma.good.findMany.mock.calls[0][0].include.barcodes).toBeDefined();
      expect(res.items[0].barcodes).toEqual([]);
    });

    // Bug #N (cross-org): sub-ШК фільтр `barcodes.some.orgId` мусить бути orgId ЗАПИТУВАЧА,
    // а не «власного» orgId штрихкоду. Товар org-B зі ШК «999» НЕ повинен потрапити у
    // видачу org-A. Дискримінуючий: якщо some.orgId колись захардкодять/впустять — тест впаде.
    it('?q= sub-ШК some.orgId == orgId запитувача (не leak між org)', async () => {
      prisma.good.findMany.mockResolvedValueOnce([]);
      prisma.good.count.mockResolvedValueOnce(0);
      await service.findAll('org-A', q({ q: '999' }));
      const where = prisma.good.findMany.mock.calls[0][0].where;
      expect(where.orgId).toBe('org-A'); // parent scope
      const some = (where.OR as Array<Record<string, any>>).find(c => 'barcodes' in c)!.barcodes
        .some;
      expect(some.orgId).toBe('org-A'); // nested filter теж по запитувачу
      expect(some.orgId).not.toBe('org-B');
    });

    it('?barcode= sub-ШК some.orgId == orgId запитувача (не leak між org)', async () => {
      prisma.good.findMany.mockResolvedValueOnce([]);
      prisma.good.count.mockResolvedValueOnce(0);
      await service.findAll('org-A', q({ barcode: '999' }));
      const where = prisma.good.findMany.mock.calls[0][0].where;
      expect(where.orgId).toBe('org-A');
      const some = (where.OR as Array<Record<string, any>>).find(c => 'barcodes' in c)!.barcodes
        .some;
      expect(some.orgId).toBe('org-A');
    });

    // Bug #N (contains-not-exact consistency): sub-ШК матчиться EXACT (`equals`), головний ШК —
    // `contains`. Введене «12» → sub-ШК «123456» НЕ збіжиться (рівність), але головний
    // barcode «123456» contains-збіжиться. Дискримінуючий: фіксує що гілки різні за семантикою.
    it('?q= sub-ШК гілка exact (equals), головний barcode гілка contains', async () => {
      prisma.good.findMany.mockResolvedValueOnce([]);
      prisma.good.count.mockResolvedValueOnce(0);
      await service.findAll('org-1', q({ q: '12' }));
      const branches = prisma.good.findMany.mock.calls[0][0].where.OR as Array<Record<string, any>>;
      const mainBarcode = branches.find(b => b.barcode && typeof b.barcode === 'object');
      const subBarcode = branches.find(b => 'barcodes' in b);
      // головний ШК: contains (часткове співпадіння)
      expect(mainBarcode!.barcode.contains).toBe('12');
      // sub-ШК: equals (точний код від сканера)
      expect(subBarcode!.barcodes.some.barcode).toEqual({ equals: '12' });
    });
  });
});
