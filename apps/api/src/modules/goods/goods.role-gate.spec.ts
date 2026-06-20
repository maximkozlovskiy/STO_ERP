import { describe, it, expect, vi } from 'vitest';
import { GoodsService } from './goods.service';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { DocumentNumberService } from '../document-number/document-number.service';

// ─── Regression spec for §2.1 Auth — purchasePrice role-gating ────────────────
//
// sto-review (2026-06-20): фінансово чутливе поле `GoodResponseDto.purchasePrice`
// (закупівельна ціна) маскується для не-привілейованих ролей.
// Дозволені ролі: OWNER, ADMIN, STOREKEEPER, ACCOUNTANT.
// MECHANIC/RECEPTIONIST бачать каталог (Roles на @Get/findAll/findOne), але НЕ
// повинні бачити закупівельну ціну (cost leakage → можна вирахувати маржу).
//
// Симетричний spec до work-orders.role-gate.spec.ts (costPrice gating).
//
// Цей spec ловить регресії:
//   A: видалення `userRole` параметра з findOne/toDto (purchasePrice витікає всім).
//   B: typo у PURCHASE_PRICE_VISIBLE_ROLES set (MECHANIC потрапляє в whitelist).
//   C: default `userRole = 'OWNER'` для backward-compat (витік для всіх).
//   D: розрив fail-closed для `userRole === undefined` (має → null).
//   E: неіснуюча роль (e.g. 'GUEST') повертає purchasePrice (має → null).
//   F: `purchasePrice === null` у БД для привілейованої ролі → `null` (не маскується).

const ORG = '11111111-1111-4111-8111-111111111111';
const GOOD_ID = '22222222-2222-4222-8222-222222222222';

function makePrismaWithGood(purchasePrice: number | null) {
  const goodRow = {
    id: GOOD_ID,
    orgId: ORG,
    internalCode: 'T-000001',
    sku: 'OIL',
    name: 'Олива',
    unit: 'шт',
    unitId: null,
    brandId: null,
    purchasePrice: purchasePrice !== null ? new Prisma.Decimal(purchasePrice) : null,
    salePrice: new Prisma.Decimal(150),
    category: null,
    barcode: null,
    notes: null,
    goodType: null,
    preferredSupplierId: null,
    preferredSupplier: null,
    brand: null,
    goodCategory: null,
    goodCategoryId: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
  return {
    good: {
      findFirst: vi.fn().mockResolvedValue(goodRow),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
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
    stockItem: { groupBy: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  };
}

function makeService(prisma: unknown): GoodsService {
  const docNumbers = { next: vi.fn().mockResolvedValue('T-000001') };
  return new GoodsService(
    prisma as unknown as PrismaService,
    docNumbers as unknown as DocumentNumberService,
  );
}

describe('GoodsService.findOne — purchasePrice role-gating', () => {
  // ─── 1. Привілейовані ролі — purchasePrice ВИДИМИЙ ─────────────────────────
  it.each(['OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT'])(
    '%s бачить purchasePrice (число) коли значення встановлене',
    async role => {
      const prisma = makePrismaWithGood(100);
      const service = makeService(prisma);

      const good = await service.findOne(ORG, GOOD_ID, role);
      expect(good.purchasePrice).toBe(100);
    },
  );

  it.each(['OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT'])(
    '%s отримує purchasePrice=null коли значення IS NULL у БД (доступ є)',
    async role => {
      const prisma = makePrismaWithGood(null);
      const service = makeService(prisma);

      const good = await service.findOne(ORG, GOOD_ID, role);
      expect(good.purchasePrice).toBeNull();
    },
  );

  // ─── 2. НЕ-привілейовані ролі — purchasePrice ПРИХОВАНИЙ ───────────────────
  it.each(['MECHANIC', 'RECEPTIONIST'])(
    '%s НЕ бачить purchasePrice (поле → null у DTO)',
    async role => {
      const prisma = makePrismaWithGood(100);
      const service = makeService(prisma);

      const good = await service.findOne(ORG, GOOD_ID, role);
      expect(good.purchasePrice).toBeNull();
    },
  );

  // ─── 3. Fail-closed — undefined/unknown ролі → null (приховано) ────────────
  it('userRole === undefined → fail-closed → purchasePrice null', async () => {
    const prisma = makePrismaWithGood(100);
    const service = makeService(prisma);

    const good = await service.findOne(ORG, GOOD_ID);
    expect(good.purchasePrice).toBeNull();
  });

  it('невідома роль (e.g. майбутній GUEST/PARTNER) → fail-closed → null', async () => {
    const prisma = makePrismaWithGood(100);
    const service = makeService(prisma);

    const good = await service.findOne(ORG, GOOD_ID, 'GUEST');
    expect(good.purchasePrice).toBeNull();
  });

  it('userRole === "" (порожній рядок) → fail-closed → null', async () => {
    const prisma = makePrismaWithGood(100);
    const service = makeService(prisma);

    const good = await service.findOne(ORG, GOOD_ID, '');
    expect(good.purchasePrice).toBeNull();
  });

  // ─── 4. Маскування НЕ ламає інші поля DTO ──────────────────────────────────
  it('маскування purchasePrice НЕ впливає на salePrice/name/sku', async () => {
    const prisma = makePrismaWithGood(100);
    const service = makeService(prisma);

    const good = await service.findOne(ORG, GOOD_ID, 'MECHANIC');
    expect(good.purchasePrice).toBeNull();
    expect(good.salePrice).toBe(150);
    expect(good.name).toBe('Олива');
    expect(good.sku).toBe('OIL');
  });
});
