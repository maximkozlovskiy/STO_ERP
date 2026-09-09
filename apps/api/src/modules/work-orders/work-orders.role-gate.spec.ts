import { describe, it, expect, vi } from 'vitest';
import { WorkOrdersService } from './work-orders.service';
import type { PrismaService } from '../../prisma/prisma.service';

// ─── Regression spec for §2.1 Auth — costPrice role-gating (commit 6d35157a) ──
//
// Bug #527 (sto-tester 2026-06-17): фінансово чутливе поле
// `WorkOrderPartResponseDto.costPrice` (батч-собівартість запчастини) маскується
// для не-привілейованих ролей. Дозволені ролі: OWNER, ADMIN, STOREKEEPER, ACCOUNTANT
// (узгоджено з goods.controller.ts:242, де ті ж ролі бачать ціну закупки у каталозі).
//
// Цей spec ловить регресії:
//   #527-A: видалення `userRole` параметра з findOne/toPartDto (костПрайс
//           прокидається всім).
//   #527-B: typo у COST_PRICE_VISIBLE_ROLES set (MECHANIC потрапляє в whitelist).
//   #527-C: default `userRole = 'OWNER'` для backward-compat (витік для всіх,
//           хто десь забув передати role).
//   #527-D: розрив fail-closed для `userRole === undefined` (має → costPrice undefined).
//   #527-E: неіснуюча роль (e.g. 'GUEST') повертає costPrice (має → undefined).
//   #527-F: `batchCostPrice === null` для привілейованої ролі → `costPrice: null`,
//           не undefined (отличие: undefined = не дозволено, null = дозволено,
//           але батч ще не списаний).

const ORG = '11111111-1111-4111-8111-111111111111';
const WO_ID = '22222222-2222-4222-8222-222222222222';
const PART_ID = '33333333-3333-4333-8333-333333333333';

function makePrismaWithPart(batchCostPrice: number | null) {
  const findFirst = vi.fn().mockResolvedValue({
    id: WO_ID,
    orgId: ORG,
    number: 'WO-2026-0001',
    status: 'DRAFT',
    priority: 'NORMAL',
    repairCategory: null,
    branchId: 'b-1',
    branch: { name: 'Br' },
    vehicleId: 'v-1',
    vehicle: { make: 'X', model: 'Y', licensePlate: 'AB1234' },
    counterpartyId: 'c-1',
    counterparty: { firstName: 'Іван', lastName: 'Петров', companyName: null },
    contractId: null,
    contract: null,
    liftId: null,
    lift: null,
    description: null,
    inMileage: null,
    outMileage: null,
    plannedAt: null,
    dueDate: null,
    plannedHours: null,
    actualHours: null,
    completedAt: null,
    warrantyUntil: null,
    clientApproval: false,
    totalLabor: 0,
    totalActualLabor: 0,
    totalParts: 100,
    totalAmount: 100,
    paidAmount: 0,
    documentDate: new Date('2026-06-17'),
    syncVersion: 0n,
    createdAt: new Date('2026-06-17'),
    updatedAt: new Date('2026-06-17'),
    deletedAt: null,
    lines: [],
    parts: [
      {
        id: PART_ID,
        workOrderId: WO_ID,
        goodId: 'g-1',
        warehouseId: 'wh-1',
        quantity: 1,
        price: 100,
        amount: 100,
        // batchCostPrice — поле що role-gate-иться.
        batchCostPrice,
        unitOfMeasureId: null,
        createdAt: new Date('2026-06-17'),
        // Bug #541: mock відображає весь shape `PART_GOOD_INCLUDE` — internalCode/sku/brand
        // потрапляють у toPartDto і назад у DTO. Якщо хтось видалить один із полів із
        // const shape — асерції нижче зловлять регресію.
        good: {
          name: 'Масло',
          internalCode: 'INT-001',
          sku: 'SKU-1',
          unit: 'л',
          unitOfMeasure: null,
          brand: { name: 'Toyota' },
        },
      },
    ],
    _count: { warranties: 0 },
    calendarSlots: [],
  });

  const goodUoMFindMany = vi.fn().mockResolvedValue([]);

  const prisma = {
    workOrder: { findFirst },
    goodUoM: { findMany: goodUoMFindMany },
  } as unknown as PrismaService;

  return prisma;
}

function makeService(prisma: PrismaService): WorkOrdersService {
  // findOne touches тільки prisma — інші deps unused, ОКРІМ settingsService.
  // Bug #536: addPart/updatePart викликають recalcTotals(), яка читає
  // settingsService.getDefaultVatRate(orgId) для розрахунку totalVat.
  // findOne НЕ викликає recalcTotals — їй settingsService не потрібен,
  // але одна спільна factory для всіх тестів простіше підтримувати.
  const settingsService = {
    getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }),
  } as never;
  return new WorkOrdersService(
    prisma,
    null as never, // inventory
    null as never, // settlements
    null as never, // notifications
    null as never, // docNumbers
    null as never, // pdf
    null as never, // audit
    settingsService, // settingsService (Bug #536)
    null as never, // config
    null as never, // events (EventEmitter2)
  );
}

describe('WorkOrdersService.findOne — costPrice role-gating (Bug #527)', () => {
  // ─── 1. Привілейовані ролі — costPrice ВИДИМИЙ ───────────────────────────

  it.each([['OWNER'], ['ADMIN'], ['STOREKEEPER'], ['ACCOUNTANT']])(
    '%s бачить costPrice (число) коли batchCostPrice встановлений',
    async role => {
      const prisma = makePrismaWithPart(42.5);
      const service = makeService(prisma);

      const wo = await service.findOne(ORG, WO_ID, role);
      expect(wo.parts).toHaveLength(1);
      // КРИТИЧНО: костПрайс має бути присутнім та дорівнювати batchCostPrice.
      expect(wo.parts[0].costPrice).toBe(42.5);
    },
  );

  it.each([['OWNER'], ['ADMIN'], ['STOREKEEPER'], ['ACCOUNTANT']])(
    '%s отримує costPrice=null коли batchCostPrice IS NULL (доступ є, але батч не списаний)',
    async role => {
      const prisma = makePrismaWithPart(null);
      const service = makeService(prisma);

      const wo = await service.findOne(ORG, WO_ID, role);
      // null = «доступ є, але cost-tracking ще не відбувся» — інше від undefined.
      expect(wo.parts[0].costPrice).toBeNull();
    },
  );

  // ─── 2. НЕ-привілейовані ролі — costPrice ПРИХОВАНИЙ ──────────────────────

  it.each([['MECHANIC'], ['RECEPTIONIST'], ['CLIENT']])(
    '%s НЕ бачить costPrice (поле відсутнє/undefined у DTO)',
    async role => {
      const prisma = makePrismaWithPart(42.5);
      const service = makeService(prisma);

      const wo = await service.findOne(ORG, WO_ID, role);
      // КРИТИЧНО: костПрайс має бути undefined (key відсутній у DTO).
      // undefined → ApiPropertyOptional не серіалізує → клієнт не бачить.
      expect(wo.parts[0].costPrice).toBeUndefined();
    },
  );

  // ─── 3. Fail-closed на edge cases ────────────────────────────────────────

  it('userRole === undefined → fail-closed → costPrice undefined', async () => {
    const prisma = makePrismaWithPart(42.5);
    const service = makeService(prisma);

    // findOne викликаний БЕЗ userRole (e.g., internal background job, або
    // регресія у controller що пропустив @CurrentUser).
    const wo = await service.findOne(ORG, WO_ID);
    expect(wo.parts[0].costPrice).toBeUndefined();
  });

  it('невідома роль (e.g. майбутній GUEST/PARTNER) → fail-closed → costPrice undefined', async () => {
    const prisma = makePrismaWithPart(42.5);
    const service = makeService(prisma);

    // Нова роль, додана у schema але ще не у COST_PRICE_VISIBLE_ROLES — НЕ
    // повинна автоматично отримувати доступ. Це опорна точка для security:
    // whitelist (не blacklist) — будь-який нечіткий статус = deny.
    const wo = await service.findOne(ORG, WO_ID, 'GUEST');
    expect(wo.parts[0].costPrice).toBeUndefined();
  });

  it('userRole === "" (порожній рядок) → fail-closed → costPrice undefined', async () => {
    const prisma = makePrismaWithPart(42.5);
    const service = makeService(prisma);

    // Edge case: щось зломалось у auth (JWT без role claim).
    // !!'' === false → fail-closed.
    const wo = await service.findOne(ORG, WO_ID, '');
    expect(wo.parts[0].costPrice).toBeUndefined();
  });

  // ─── 4. Регресія-guard: контракт повертає інші поля незмінно ──────────────

  it('маскування costPrice НЕ ламає інші поля part DTO', async () => {
    const prisma = makePrismaWithPart(42.5);
    const service = makeService(prisma);

    const wo = await service.findOne(ORG, WO_ID, 'MECHANIC');
    expect(wo.parts[0]).toMatchObject({
      id: PART_ID,
      workOrderId: WO_ID,
      goodId: 'g-1',
      warehouseId: 'wh-1',
      quantity: 1,
      price: 100,
      amount: 100,
    });
    // АЛЕ costPrice — undefined (приховано).
    expect(wo.parts[0].costPrice).toBeUndefined();
  });

  // ─── 6. Bug #541: regression-guard для PART_GOOD_INCLUDE drift ───────────────
  // Refactor у commit a50e1484 витяг shared PART_GOOD_INCLUDE const з 3 ідентичних
  // include shape-ів. Якщо хтось видалить internalCode/sku/brand із const —
  // toPartDto продовжує мапити (`good?.internalCode ?? null`), TS green, а на
  // runtime фронт отримує null навіть якщо у БД є значення (silent UX regression).
  it('Bug #541: WorkOrderPart DTO містить goodInternalCode / goodSku / goodBrandName', async () => {
    const prisma = makePrismaWithPart(42.5);
    const service = makeService(prisma);

    const wo = await service.findOne(ORG, WO_ID, 'OWNER');
    expect(wo.parts[0]).toMatchObject({
      goodName: 'Масло',
      goodInternalCode: 'INT-001',
      goodSku: 'SKU-1',
      goodBrandName: 'Toyota',
    });
  });

  // ─── 5. Case-sensitivity (security-critical) ──────────────────────────────

  it('lowercase "owner" → fail-closed (case-sensitive Set lookup)', async () => {
    const prisma = makePrismaWithPart(42.5);
    const service = makeService(prisma);

    // JWT role claim має бути канонічним UPPERCASE. Якщо хтось ламає це
    // (рефакторинг auth) — fail-closed краще ніж lax matching.
    const wo = await service.findOne(ORG, WO_ID, 'owner');
    expect(wo.parts[0].costPrice).toBeUndefined();
  });
});

// ─── addPart/updatePart симетричне role-gating (Bug #529) ──────────────────
//
// addPart/updatePart мутують WorkOrderPart і повертають WorkOrderPartResponseDto.
// Без userRole параметра OWNER/ADMIN отримав би undefined costPrice → треба
// refresh detail page (UX inconsistency). Регресія-guard: будь-який refactor
// що видаляє userRole з addPart/updatePart → CI червоніє.

function makePrismaForAddPart(batchCostPrice: number | null) {
  // findFirst шари для wo + good + warehouse — addPart parallel guard
  const woFindFirst = vi.fn().mockResolvedValue({ status: 'DRAFT' });
  const goodFindFirst = vi.fn().mockResolvedValue({ salePrice: 100 });
  const warehouseFindFirst = vi.fn().mockResolvedValue({ id: 'wh-1' });
  const goodUoMFindFirst = vi.fn().mockResolvedValue(null);
  // Створений part з batchCostPrice — це поле role-gate-иться.
  // Bug #541: shape `good` дзеркалить PART_GOOD_INCLUDE — включає internalCode/sku/brand
  // щоб addPart-флоу був також guarded від drift-у const-include shape.
  const partCreate = vi.fn().mockResolvedValue({
    id: PART_ID,
    workOrderId: WO_ID,
    goodId: 'g-1',
    warehouseId: 'wh-1',
    quantity: 1,
    price: 100,
    amount: 100,
    batchCostPrice,
    unitOfMeasureId: null,
    createdAt: new Date('2026-06-17'),
    good: {
      name: 'Масло',
      internalCode: 'INT-001',
      sku: 'SKU-1',
      unit: 'л',
      unitOfMeasure: null,
      brand: { name: 'Toyota' },
    },
  });
  const lineFindMany = vi.fn().mockResolvedValue([]);
  const partAggregate = vi.fn().mockResolvedValue({ _sum: { amount: 100 } });
  const woUpdate = vi.fn().mockResolvedValue({});

  const tx = {
    workOrder: { update: woUpdate },
    workOrderLine: { findMany: lineFindMany },
    workOrderPart: { create: partCreate, aggregate: partAggregate },
  };

  const prisma = {
    workOrder: { findFirst: woFindFirst },
    good: { findFirst: goodFindFirst },
    warehouse: { findFirst: warehouseFindFirst },
    goodUoM: { findFirst: goodUoMFindFirst },
    $transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as PrismaService;

  return prisma;
}

describe('WorkOrdersService.addPart — costPrice role-gating (Bug #529)', () => {
  it('OWNER → costPrice ВИДИМИЙ у відповіді addPart', async () => {
    const prisma = makePrismaForAddPart(42.5);
    const service = makeService(prisma);

    const part = await service.addPart(
      ORG,
      WO_ID,
      {
        goodId: '99999999-9999-4999-8999-999999999999',
        warehouseId: '88888888-8888-4888-8888-888888888888',
        quantity: 1,
      },
      'OWNER',
    );
    expect(part.costPrice).toBe(42.5);
  });

  it('MECHANIC → costPrice ПРИХОВАНИЙ у відповіді addPart', async () => {
    const prisma = makePrismaForAddPart(42.5);
    const service = makeService(prisma);

    const part = await service.addPart(
      ORG,
      WO_ID,
      {
        goodId: '99999999-9999-4999-8999-999999999999',
        warehouseId: '88888888-8888-4888-8888-888888888888',
        quantity: 1,
      },
      'MECHANIC',
    );
    expect(part.costPrice).toBeUndefined();
  });

  it('addPart без userRole → fail-closed → costPrice undefined (backward-compat sanity)', async () => {
    const prisma = makePrismaForAddPart(42.5);
    const service = makeService(prisma);

    // Старий code-path без userRole — повинен залишитися fail-closed.
    const part = await service.addPart(ORG, WO_ID, {
      goodId: '99999999-9999-4999-8999-999999999999',
      warehouseId: '88888888-8888-4888-8888-888888888888',
      quantity: 1,
    });
    expect(part.costPrice).toBeUndefined();
  });

  // Bug #541: addPart-флоу також має включати goodInternalCode / goodSku / goodBrandName.
  // Дублює guard у findOne (вище), щоб refactor `PART_GOOD_INCLUDE` ловився на трьох
  // call-site-ах (findOne / addPart / updatePart) — а не лише там де costPrice ловиться.
  it('Bug #541: addPart DTO містить goodInternalCode / goodSku / goodBrandName', async () => {
    const prisma = makePrismaForAddPart(42.5);
    const service = makeService(prisma);

    const part = await service.addPart(
      ORG,
      WO_ID,
      {
        goodId: '99999999-9999-4999-8999-999999999999',
        warehouseId: '88888888-8888-4888-8888-888888888888',
        quantity: 1,
      },
      'OWNER',
    );
    expect(part).toMatchObject({
      goodName: 'Масло',
      goodInternalCode: 'INT-001',
      goodSku: 'SKU-1',
      goodBrandName: 'Toyota',
    });
  });
});

function makePrismaForUpdatePart(batchCostPrice: number | null) {
  const woFindFirst = vi.fn().mockResolvedValue({ status: 'DRAFT' });
  const partFindFirst = vi
    .fn()
    .mockResolvedValue({ quantity: 1, price: 100, goodId: 'g-1', unitOfMeasureId: null });
  const partUpdate = vi.fn().mockResolvedValue({
    id: PART_ID,
    workOrderId: WO_ID,
    goodId: 'g-1',
    warehouseId: 'wh-1',
    quantity: 2,
    price: 100,
    amount: 200,
    batchCostPrice,
    unitOfMeasureId: null,
    createdAt: new Date('2026-06-17'),
    good: { name: 'Масло', unit: 'л', unitOfMeasure: null },
  });
  const lineFindMany = vi.fn().mockResolvedValue([]);
  const partAggregate = vi.fn().mockResolvedValue({ _sum: { amount: 200 } });
  const woUpdate = vi.fn().mockResolvedValue({});

  const tx = {
    workOrder: { update: woUpdate },
    workOrderLine: { findMany: lineFindMany },
    workOrderPart: { update: partUpdate, aggregate: partAggregate },
  };

  const prisma = {
    workOrder: { findFirst: woFindFirst },
    workOrderPart: { findFirst: partFindFirst },
    $transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as PrismaService;

  return prisma;
}

describe('WorkOrdersService.updatePart — costPrice role-gating (Bug #529)', () => {
  it('ADMIN → costPrice ВИДИМИЙ у відповіді updatePart', async () => {
    const prisma = makePrismaForUpdatePart(42.5);
    const service = makeService(prisma);

    const part = await service.updatePart(ORG, WO_ID, PART_ID, { quantity: 2 }, 'ADMIN');
    expect(part.costPrice).toBe(42.5);
  });

  it('RECEPTIONIST → costPrice ПРИХОВАНИЙ (allowed для mutation, але не для cost-view)', async () => {
    const prisma = makePrismaForUpdatePart(42.5);
    const service = makeService(prisma);

    // RECEPTIONIST у Roles('OWNER', 'ADMIN', 'RECEPTIONIST') для PATCH —
    // дозволено редагувати quantity/price, але НЕ бачити батч-собівартість.
    const part = await service.updatePart(ORG, WO_ID, PART_ID, { quantity: 2 }, 'RECEPTIONIST');
    expect(part.costPrice).toBeUndefined();
  });

  it('updatePart без userRole → fail-closed → costPrice undefined', async () => {
    const prisma = makePrismaForUpdatePart(42.5);
    const service = makeService(prisma);

    const part = await service.updatePart(ORG, WO_ID, PART_ID, { quantity: 2 });
    expect(part.costPrice).toBeUndefined();
  });
});
