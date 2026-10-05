/**
 * PurchaseOrdersService — receive — UoM-override і tenant-валідація (Bug #239)
 *
 * Виділено з `purchase-orders.service.spec.ts` (був 1960 рядків, 7 незалежних
 * describe-блоків) 2026-10-05. Кейси перенесені ДОСЛІВНО, жоден it() не змінено:
 * сумарна кількість до і після розбиття — 55, перевірено раннером.
 *
 * Спільні DI-провайдери — `./purchase-orders.spec-fixture`.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PurchaseOrderStatus } from '@prisma/client';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PricingService } from '../inventory/pricing.service';
import { SettingsService } from '../settings/settings.service';
import { DeliveryTrackingService } from './delivery/delivery-tracking.service';
import { exchangeRatesProvider } from './purchase-orders.spec-fixture';
import { kyivToday, addDaysKyiv } from '../../common/utils/kyiv-date';

describe('PurchaseOrdersService.receive — UoM override tenant validation (Bug #239)', () => {
  let service: PurchaseOrdersService;
  let prisma: {
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    purchaseOrderLine: {
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
    unitOfMeasure: { findMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let inventory: { createMovement: ReturnType<typeof vi.fn> };
  let settlements: { createTransaction: ReturnType<typeof vi.fn> };

  const ORG = 'org-A';
  const PO_ID = '11111111-1111-4111-8111-111111111111';
  const LINE_ID = '22222222-2222-4222-8222-222222222222';
  const GOOD_ID = '33333333-3333-4333-8333-333333333333';
  const SUPPLIER_ID = '44444444-4444-4444-8444-444444444444';
  const WAREHOUSE_ID = '55555555-5555-4555-8555-555555555555';
  const USER_ID = '66666666-6666-4666-8666-666666666666';
  const GOOD_UNIT_ID = '77777777-7777-4777-8777-777777777777'; // own-org default UoM
  const OWN_UOM_ID = '88888888-8888-4888-8888-888888888888'; // own-org override UoM
  const CROSS_UOM_ID = '99999999-9999-4999-8999-999999999999'; // foreign-org UoM

  beforeEach(async () => {
    prisma = {
      purchaseOrder: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      purchaseOrderLine: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }), // CAS receive: default success
        findMany: vi.fn(),
      },
      unitOfMeasure: { findMany: vi.fn() },
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
    };
    inventory = { createMovement: vi.fn().mockResolvedValue(undefined) };
    settlements = { createTransaction: vi.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        PurchaseOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: inventory },
        { provide: SettlementsService, useValue: settlements },
        { provide: DocumentNumberService, useValue: {} },
        { provide: PricingService, useValue: {} },
        // Bug #536: SettingsService потрібен для calcLineVat у create/update/receive paths.
        {
          provide: SettingsService,
          useValue: {
            getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }),
          },
        },
        {
          provide: DeliveryTrackingService,
          useValue: { enqueueInitial: vi.fn().mockResolvedValue(undefined) },
        },
        exchangeRatesProvider(),
      ],
    }).compile();
    service = module.get(PurchaseOrdersService);

    // Default PO fixture: ORDERED status, one line, RECEIVED qty = 0
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.ORDERED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 0,
          good: { unitId: GOOD_UNIT_ID },
        },
      ],
    });
    // After increment all received → triggers RECEIVED status branch
    prisma.purchaseOrderLine.findMany.mockResolvedValue([
      { id: LINE_ID, quantity: 10, receivedQty: 10 },
    ]);
    // findOne after receive — return same PO (service calls this.findOne at end)
    // Will be matched by 2nd findFirst call
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.ORDERED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      totalAmount: 1000,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 0,
          good: { unitId: GOOD_UNIT_ID },
        },
      ],
    });
  });

  it('receive без unitOfMeasureId override → fallback на good.unitId, createMovement отримує good.unitId', async () => {
    // In-tx guard re-read (Bug #616 guard): має повернути ТОЙ САМИЙ статус що pre-tx (ORDERED),
    // інакше `fresh.status !== po.status` кине BadRequestException. Черга Once: pre-tx (beforeEach),
    // потім цей guard, потім persistent findOne (RECEIVED нижче).
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ status: PurchaseOrderStatus.ORDERED });
    // Final findOne after receive (для return value) — service викликає findOne(orgId, id) внутрішньо
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.RECEIVED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      totalAmount: 1000,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 10,
          good: { name: 'X', sku: null, unit: 'шт', unitOfMeasure: null },
          unitOfMeasureId: GOOD_UNIT_ID,
        },
      ],
      supplier: { firstName: 'S', lastName: '', companyName: null },
      warehouse: { name: 'W' },
    });

    await service.receive(ORG, PO_ID, { lines: [{ lineId: LINE_ID, receivedQty: 10 }] }, USER_ID);

    // unitOfMeasure.findMany НЕ викликаний (overrideUomIds порожній)
    expect(prisma.unitOfMeasure.findMany).not.toHaveBeenCalled();
    // inventory.createMovement отримав unitOfMeasureId з good.unitId
    expect(inventory.createMovement).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ unitOfMeasureId: GOOD_UNIT_ID, goodId: GOOD_ID }),
      expect.anything(),
    );
    // receive пише SUPPLIER_CHARGE (−1: ми винні постачальнику), НЕ CHARGE (+1, клієнтський).
    // Fix знаку балансу постачальника — без цього графік оплат не бачить проведених PO.
    expect(settlements.createTransaction).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        counterpartyId: SUPPLIER_ID,
        type: 'SUPPLIER_CHARGE',
        amount: 1000,
        documentType: 'PurchaseOrder',
      }),
      expect.anything(),
    );
  });

  it('receive з own-org unitOfMeasureId override → unitOfMeasure.findMany викликано з orgId, override застосовано', async () => {
    prisma.unitOfMeasure.findMany.mockResolvedValueOnce([{ id: OWN_UOM_ID }]);
    // In-tx guard re-read (Bug #616): статус має збігатися з pre-tx (ORDERED) → не throw.
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ status: PurchaseOrderStatus.ORDERED });
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.RECEIVED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      totalAmount: 1000,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 10,
          good: { name: 'X', sku: null, unit: 'шт', unitOfMeasure: null },
          unitOfMeasureId: OWN_UOM_ID,
        },
      ],
      supplier: { firstName: 'S', lastName: '', companyName: null },
      warehouse: { name: 'W' },
    });

    await service.receive(
      ORG,
      PO_ID,
      { lines: [{ lineId: LINE_ID, receivedQty: 10, unitOfMeasureId: OWN_UOM_ID }] },
      USER_ID,
    );

    // Tenant validation викликана з orgId і id ∈ overrideUomIds
    expect(prisma.unitOfMeasure.findMany).toHaveBeenCalledWith({
      where: { orgId: ORG, id: { in: [OWN_UOM_ID] }, deletedAt: null },
      select: { id: true },
      take: 1000,
    });
    // resolvedUomId = override (не good.unitId)
    expect(inventory.createMovement).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ unitOfMeasureId: OWN_UOM_ID }),
      expect.anything(),
    );
  });

  it('receive з cross-tenant unitOfMeasureId → BadRequestException, inventory write НЕ викликаний (Bug #186)', async () => {
    // findMany повертає порожній масив — UoM не знайдено в org
    prisma.unitOfMeasure.findMany.mockResolvedValueOnce([]);

    await expect(
      service.receive(
        ORG,
        PO_ID,
        { lines: [{ lineId: LINE_ID, receivedQty: 10, unitOfMeasureId: CROSS_UOM_ID }] },
        USER_ID,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.unitOfMeasure.findMany).toHaveBeenCalledWith({
      where: { orgId: ORG, id: { in: [CROSS_UOM_ID] }, deletedAt: null },
      select: { id: true },
      take: 1000,
    });
    // Жоден write — захист от cross-tenant linkage
    expect(inventory.createMovement).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
    expect(prisma.purchaseOrderLine.update).not.toHaveBeenCalled();
  });

  it('receive — кілька рядків з різними override-UoM: всі валідуються одним findMany (батч)', async () => {
    const LINE_ID_2 = '22222222-2222-4222-8222-222222222223';
    const OWN_UOM_ID_2 = '88888888-8888-4888-8888-888888888889';

    prisma.unitOfMeasure.findMany.mockResolvedValueOnce([{ id: OWN_UOM_ID }, { id: OWN_UOM_ID_2 }]);
    prisma.purchaseOrder.findFirst.mockReset();
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.ORDERED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 5,
          price: 100,
          receivedQty: 0,
          good: { unitId: GOOD_UNIT_ID },
        },
        {
          id: LINE_ID_2,
          goodId: GOOD_ID,
          quantity: 5,
          price: 100,
          receivedQty: 0,
          good: { unitId: GOOD_UNIT_ID },
        },
      ],
    });
    prisma.purchaseOrderLine.findMany.mockResolvedValueOnce([
      { id: LINE_ID, quantity: 5, receivedQty: 5 },
      { id: LINE_ID_2, quantity: 5, receivedQty: 5 },
    ]);
    // In-tx guard re-read (Bug #616): між pre-tx (ORDERED вище) і findOne (RECEIVED нижче).
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ status: PurchaseOrderStatus.ORDERED });
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.RECEIVED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      totalAmount: 1000,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 5,
          price: 100,
          receivedQty: 5,
          good: { name: 'X', sku: null, unit: 'шт', unitOfMeasure: null },
          unitOfMeasureId: OWN_UOM_ID,
        },
      ],
      supplier: { firstName: 'S', lastName: '', companyName: null },
      warehouse: { name: 'W' },
    });

    await service.receive(
      ORG,
      PO_ID,
      {
        lines: [
          { lineId: LINE_ID, receivedQty: 5, unitOfMeasureId: OWN_UOM_ID },
          { lineId: LINE_ID_2, receivedQty: 5, unitOfMeasureId: OWN_UOM_ID_2 },
        ],
      },
      USER_ID,
    );

    // Один батчевий findMany з in:[a,b], не два окремих запита
    expect(prisma.unitOfMeasure.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.unitOfMeasure.findMany).toHaveBeenCalledWith({
      where: {
        orgId: ORG,
        id: expect.objectContaining({ in: expect.arrayContaining([OWN_UOM_ID, OWN_UOM_ID_2]) }),
        deletedAt: null,
      },
      select: { id: true },
      take: 1000,
    });
  });

  // Bug #237: partial receive не перезаписує line UoM коли override відсутній
  it('Bug #237: partial receive без override → line.unitOfMeasureId НЕ оновлюється (receivedQty > 0)', async () => {
    prisma.purchaseOrder.findFirst.mockReset();
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.PARTIAL,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 3, // already partially received
          good: { unitId: GOOD_UNIT_ID },
        },
      ],
    });
    prisma.purchaseOrderLine.findMany.mockResolvedValueOnce([
      { id: LINE_ID, quantity: 10, receivedQty: 10 },
    ]);
    // In-tx guard re-read (Bug #616): статус має збігатися з pre-tx (PARTIAL) → не throw.
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ status: PurchaseOrderStatus.PARTIAL });
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.RECEIVED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      totalAmount: 1000,
      lines: [],
      supplier: { firstName: 'S', lastName: '', companyName: null },
      warehouse: { name: 'W' },
    });

    await service.receive(ORG, PO_ID, { lines: [{ lineId: LINE_ID, receivedQty: 7 }] }, USER_ID);

    // CAS updateMany — where містить очікуваний receivedQty (3), data БЕЗ unitOfMeasureId
    expect(prisma.purchaseOrderLine.updateMany).toHaveBeenCalledWith({
      where: { id: LINE_ID, orgId: ORG, receivedQty: 3 },
      data: { receivedQty: { increment: 7 } },
    });
  });

  it('Bug #237: partial receive з explicit override → line.unitOfMeasureId оновлюється (intent)', async () => {
    prisma.unitOfMeasure.findMany.mockResolvedValueOnce([{ id: OWN_UOM_ID }]);
    prisma.purchaseOrder.findFirst.mockReset();
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.PARTIAL,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 3,
          good: { unitId: GOOD_UNIT_ID },
        },
      ],
    });
    prisma.purchaseOrderLine.findMany.mockResolvedValueOnce([
      { id: LINE_ID, quantity: 10, receivedQty: 10 },
    ]);
    // In-tx guard re-read (Bug #616): статус має збігатися з pre-tx (PARTIAL) → не throw.
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ status: PurchaseOrderStatus.PARTIAL });
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.RECEIVED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      totalAmount: 1000,
      lines: [],
      supplier: { firstName: 'S', lastName: '', companyName: null },
      warehouse: { name: 'W' },
    });

    await service.receive(
      ORG,
      PO_ID,
      { lines: [{ lineId: LINE_ID, receivedQty: 7, unitOfMeasureId: OWN_UOM_ID }] },
      USER_ID,
    );

    // explicit override → unitOfMeasureId присутній у data; CAS where з очікуваним receivedQty(3)
    expect(prisma.purchaseOrderLine.updateMany).toHaveBeenCalledWith({
      where: { id: LINE_ID, orgId: ORG, receivedQty: 3 },
      data: { receivedQty: { increment: 7 }, unitOfMeasureId: OWN_UOM_ID },
    });
  });

  it('Bug #483 (review): duplicate lineId у dto.lines → BadRequestException (без подвійного increment)', async () => {
    // Без dedup-guard Promise.all виконав би два update.increment для того самого lineId,
    // що подвоїло б receivedQty. Service кидає ще ДО $transaction.
    await expect(
      service.receive(
        ORG,
        PO_ID,
        {
          lines: [
            { lineId: LINE_ID, receivedQty: 5 },
            { lineId: LINE_ID, receivedQty: 3 }, // duplicate!
          ],
        },
        USER_ID,
      ),
    ).rejects.toThrow('Кожен рядок прийому має бути унікальним');
    // Захист спрацьовує перед $transaction → жодного запису у БД.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.purchaseOrderLine.update).not.toHaveBeenCalled();
    expect(inventory.createMovement).not.toHaveBeenCalled();
  });

  // CAS receive (pre-prod audit H1): concurrent/дубльований receive() з однаковим payload не має
  // подвоювати оприбуткування + SUPPLIER_CHARGE. updateMany where receivedQty=<очікуване> —
  // якщо інша транзакція вже змінила рядок → count=0 → throw ДО createMovement/createTransaction.
  it('CAS-guard: рядок уже змінено (updateMany count=0) → throw, БЕЗ RECEIPT-руху і БЕЗ SUPPLIER_CHARGE', async () => {
    prisma.purchaseOrder.findFirst.mockReset();
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.ORDERED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 0,
          good: { unitId: GOOD_UNIT_ID },
        },
      ],
    });
    // In-tx status re-read проходить (ORDERED незмінний) — CAS має спрацювати на рядку, не на статусі.
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ status: PurchaseOrderStatus.ORDERED });
    // Конкурентний дубль уже інкрементнув рядок → receivedQty≠0 → updateMany матчить 0 рядків.
    prisma.purchaseOrderLine.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.receive(ORG, PO_ID, { lines: [{ lineId: LINE_ID, receivedQty: 10 }] }, USER_ID),
    ).rejects.toThrow(/уже опрацьовано|змінено іншою/i);

    // MUTATION-VERIFY: якщо прибрати `if (casResult.count === 0) throw` — ці assert-и впадуть
    // (подвійне оприбуткування + подвійний борг постачальнику).
    expect(inventory.createMovement).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
  });

  it('receive повне → авто paymentDate = сьогодні + contract.paymentDeferDays (RECEIVED)', async () => {
    // PO з договором (10 днів відтермінування), без paymentDate.
    prisma.purchaseOrder.findFirst.mockReset();
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.ORDERED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      paymentDate: null,
      contract: { paymentDeferDays: 10 },
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 0,
          good: { unitId: GOOD_UNIT_ID },
        },
      ],
    });
    // In-tx guard re-read (Bug #616): статус має збігатися з pre-tx (ORDERED) → не throw.
    // Once-черга: pre-tx (ORDERED вище), потім цей guard, потім persistent findOne (RECEIVED).
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ status: PurchaseOrderStatus.ORDERED });
    // findOne у кінці
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.RECEIVED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      totalAmount: 1000,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 10,
          good: { name: 'X', sku: null, unit: 'шт', unitOfMeasure: null },
          unitOfMeasureId: GOOD_UNIT_ID,
        },
      ],
      supplier: { firstName: 'S', lastName: '', companyName: null },
      warehouse: { name: 'W' },
    });

    await service.receive(ORG, PO_ID, { lines: [{ lineId: LINE_ID, receivedQty: 10 }] }, USER_ID);

    // Останній purchaseOrder.update у $transaction — зі статусом RECEIVED + paymentDate.
    const updateCalls = prisma.purchaseOrder.update.mock.calls;
    const statusUpdate = updateCalls.find(
      c => (c[0] as { data?: { status?: string } }).data?.status === PurchaseOrderStatus.RECEIVED,
    );
    expect(statusUpdate).toBeDefined();
    const data = (statusUpdate![0] as { data: { paymentDate?: Date } }).data;
    expect(data.paymentDate).toBeInstanceOf(Date);
    // = сьогодні (Kyiv) + 10 днів. Bug #592: попередня версія тесту рахувала expected
    // через `new Date() + setUTCDate` — це UTC-арифметика, а impl використовує Kyiv (kyivToday()).
    // На кордоні днів (Kyiv +2/+3 vs UTC) різниця в 1 день → тест падає в ~3 годинних вікнах.
    // Правильно: використовувати ті самі kyivToday/addDaysKyiv що і imp (DST-aware).
    const expected = addDaysKyiv(kyivToday(), 10);
    expect(data.paymentDate!.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
  });

  it('receive без договору → paymentDate НЕ встановлюється', async () => {
    prisma.purchaseOrder.findFirst.mockReset();
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.ORDERED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      paymentDate: null,
      contract: null,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 0,
          good: { unitId: GOOD_UNIT_ID },
        },
      ],
    });
    // In-tx guard re-read (Bug #616): статус має збігатися з pre-tx (ORDERED) → не throw.
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ status: PurchaseOrderStatus.ORDERED });
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.RECEIVED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      totalAmount: 1000,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 10,
          good: { name: 'X', sku: null, unit: 'шт', unitOfMeasure: null },
          unitOfMeasureId: GOOD_UNIT_ID,
        },
      ],
      supplier: { firstName: 'S', lastName: '', companyName: null },
      warehouse: { name: 'W' },
    });

    await service.receive(ORG, PO_ID, { lines: [{ lineId: LINE_ID, receivedQty: 10 }] }, USER_ID);

    const statusUpdate = prisma.purchaseOrder.update.mock.calls.find(
      c => (c[0] as { data?: { status?: string } }).data?.status === PurchaseOrderStatus.RECEIVED,
    );
    expect(statusUpdate).toBeDefined();
    expect((statusUpdate![0] as { data: Record<string, unknown> }).data).not.toHaveProperty(
      'paymentDate',
    );
  });

  // ── Bug #712: over-receipt guard (receivedQty не може перевищити orderedQty) ──────────────
  // Mutation-verified: якщо прибрати guard `line.receivedQty + recv.receivedQty > line.quantity`,
  // прийом 100 на замовлені 10 пройшов би → RECEIPT +100 у склад + SUPPLIER_CHARGE ×100·price.
  it('Bug #712: прийом > orderedQty (fresh line) → 400, ЖОДНОГО inventory/settlement write', async () => {
    // Дефолтна фікстура beforeEach: line quantity=10, receivedQty=0. Приймаємо 11 (>10).
    await expect(
      service.receive(ORG, PO_ID, { lines: [{ lineId: LINE_ID, receivedQty: 11 }] }, USER_ID),
    ).rejects.toThrow(/перевищує залишок/);
    // Fail-fast ДО $transaction: жодного руху складу / боргу постачальнику / CAS-update рядка.
    expect(inventory.createMovement).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
    expect(prisma.purchaseOrderLine.updateMany).not.toHaveBeenCalled();
  });

  it('Bug #712: кумулятивний прийом перевищує orderedQty (partial line) → 400', async () => {
    // Лінія вже частково прийнята: quantity=10, receivedQty=7 → залишок 3. Приймаємо 5 (>3).
    prisma.purchaseOrder.findFirst.mockReset();
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.PARTIAL,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 7,
          good: { unitId: GOOD_UNIT_ID },
        },
      ],
    });
    await expect(
      service.receive(ORG, PO_ID, { lines: [{ lineId: LINE_ID, receivedQty: 5 }] }, USER_ID),
    ).rejects.toThrow(/перевищує залишок/);
    expect(inventory.createMovement).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
  });

  it('Bug #712: прийом РІВНО до orderedQty (граничний) → дозволено (не хибне 400)', async () => {
    // Boundary: quantity=10, receivedQty=0, приймаємо рівно 10 → guard НЕ спрацьовує (== не >).
    prisma.purchaseOrder.findFirst.mockReset();
    prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce({
        id: PO_ID,
        orgId: ORG,
        number: 'PO-RX',
        status: PurchaseOrderStatus.ORDERED,
        supplierId: SUPPLIER_ID,
        warehouseId: WAREHOUSE_ID,
        lines: [
          {
            id: LINE_ID,
            goodId: GOOD_ID,
            quantity: 10,
            price: 100,
            receivedQty: 0,
            good: { unitId: GOOD_UNIT_ID },
          },
        ],
      })
      .mockResolvedValueOnce({ status: PurchaseOrderStatus.ORDERED }) // in-tx guard re-read
      .mockResolvedValue({
        id: PO_ID,
        orgId: ORG,
        number: 'PO-RX',
        status: PurchaseOrderStatus.RECEIVED,
        supplierId: SUPPLIER_ID,
        warehouseId: WAREHOUSE_ID,
        totalAmount: 1000,
        lines: [
          {
            id: LINE_ID,
            goodId: GOOD_ID,
            quantity: 10,
            price: 100,
            receivedQty: 10,
            good: { name: 'X', sku: null, unit: 'шт', unitOfMeasure: null },
            unitOfMeasureId: GOOD_UNIT_ID,
          },
        ],
        supplier: { firstName: 'S', lastName: '', companyName: null },
        warehouse: { name: 'W' },
      });
    prisma.purchaseOrderLine.findMany.mockResolvedValue([
      { id: LINE_ID, quantity: 10, receivedQty: 10 },
    ]);

    await service.receive(ORG, PO_ID, { lines: [{ lineId: LINE_ID, receivedQty: 10 }] }, USER_ID);
    expect(inventory.createMovement).toHaveBeenCalledTimes(1);
    expect(settlements.createTransaction).toHaveBeenCalledTimes(1);
  });
});

// Bug #473-#476: regression guards для update() — contract resolution + tenant guards
// (commits 115fea9e + 32c6115f: editable supplier/warehouse/contract у DRAFT, auto-clear
// stale contract при зміні постачальника).
