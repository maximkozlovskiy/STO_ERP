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
  // ─── 1. Привілейовані ролі — purchasePrice ВИДИМИЙ (число або null з БД) ───
  // Об'єднаний матричний sweep: 4 ролі × 2 db-значення = 8 кейсів через одне it.each.
  it.each<{ role: string; dbValue: number | null; expected: number | null }>([
    { role: 'OWNER', dbValue: 100, expected: 100 },
    { role: 'ADMIN', dbValue: 100, expected: 100 },
    { role: 'STOREKEEPER', dbValue: 100, expected: 100 },
    { role: 'ACCOUNTANT', dbValue: 100, expected: 100 },
    { role: 'OWNER', dbValue: null, expected: null },
    { role: 'ADMIN', dbValue: null, expected: null },
    { role: 'STOREKEEPER', dbValue: null, expected: null },
    { role: 'ACCOUNTANT', dbValue: null, expected: null },
  ])(
    '$role бачить purchasePrice=$expected коли БД=$dbValue',
    async ({ role, dbValue, expected }) => {
      const service = makeService(makePrismaWithGood(dbValue));

      const good = await service.findOne(ORG, GOOD_ID, role);
      expect(good.purchasePrice).toBe(expected);
    },
  );

  // ─── 2. Не-привілейовані + fail-closed (undefined/unknown/'') → null ───────
  // Усі ці кейси мають однаковий setup (dbValue=100) і однаковий expectation
  // (purchasePrice=null). Об'єднано в один it.each (2 не-privileged + 3 fail-closed).
  it.each<{ label: string; role: string | undefined }>([
    { label: 'MECHANIC — приховано', role: 'MECHANIC' },
    { label: 'RECEPTIONIST — приховано', role: 'RECEPTIONIST' },
    { label: 'undefined → fail-closed', role: undefined },
    { label: 'unknown role (GUEST) → fail-closed', role: 'GUEST' },
    { label: 'порожній рядок → fail-closed', role: '' },
  ])('$label → purchasePrice null', async ({ role }) => {
    const service = makeService(makePrismaWithGood(100));

    const good = await service.findOne(ORG, GOOD_ID, role);
    expect(good.purchasePrice).toBeNull();
  });

  // ─── 3. Маскування НЕ ламає інші поля DTO ──────────────────────────────────
  it('маскування purchasePrice НЕ впливає на salePrice/name/sku', async () => {
    const service = makeService(makePrismaWithGood(100));

    const good = await service.findOne(ORG, GOOD_ID, 'MECHANIC');
    expect(good.purchasePrice).toBeNull();
    expect(good.salePrice).toBe(150);
    expect(good.name).toBe('Олива');
    expect(good.sku).toBe('OIL');
  });
});
