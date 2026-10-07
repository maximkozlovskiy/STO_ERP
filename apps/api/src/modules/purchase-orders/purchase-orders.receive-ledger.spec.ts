/**
 * PurchaseOrdersService — receive — порядок кроків у транзакції: CAS рядків → рух → борг
 *
 * receive() пише у три місця: `purchaseOrderLine.receivedQty`, склад (RECEIPT) і розрахунки з
 * постачальником (SUPPLIER_CHARGE). Порядок критичний: спершу CAS УСІХ рядків
 * (`updateMany where receivedQty=<очікуване>`), і лише потім рух та борг. Якщо хоч один рядок
 * уже змінив конкурентний/дубльований receive() — виняток летить до першого руху, тож ні
 * подвійного оприбуткування, ні подвійного боргу.
 *
 * Однорядковий CAS-кейс і UoM-поведінка — у `purchase-orders.receive-uom.spec.ts`. Тут те,
 * чого однорядкова фікстура показати не може: «після CAS УСІХ рядків» і «ОДИН борг на прийом».
 *
 * Мутації, якими доведено кейси: (1) блок КРОК 2 (createMovement) перенесено перед циклом CAS;
 * (2) прибрано throw при `casResult.count === 0`; (3) `receivedQty` прибрано з where CAS;
 * (4) тип руху RECEIPT → інший; (5) SUPPLIER_CHARGE → CHARGE. Кожна валить щонайменше один кейс.
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

describe('PurchaseOrdersService.receive — CAS рядків → RECEIPT → SUPPLIER_CHARGE', () => {
  let service: PurchaseOrdersService;
  let prisma: {
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    purchaseOrderLine: {
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
  const LINE_1 = '22222222-2222-4222-8222-222222222221';
  const LINE_2 = '22222222-2222-4222-8222-222222222222';
  const GOOD_1 = '33333333-3333-4333-8333-333333333331';
  const GOOD_2 = '33333333-3333-4333-8333-333333333332';
  const SUPPLIER_ID = '44444444-4444-4444-8444-444444444444';
  const WAREHOUSE_ID = '55555555-5555-4555-8555-555555555555';
  const USER_ID = '66666666-6666-4666-8666-666666666666';
  const UNIT_ID = '77777777-7777-4777-8777-777777777777';

  // Рядок 1: замовлено 10 × 100,00, уже прийнято 2. Рядок 2: замовлено 5 × 20,50, ще нічого.
  const poWithLines = {
    id: PO_ID,
    orgId: ORG,
    number: 'PO-LEDGER',
    status: PurchaseOrderStatus.PARTIAL,
    supplierId: SUPPLIER_ID,
    warehouseId: WAREHOUSE_ID,
    currencyId: null,
    paymentDate: null,
    contract: null,
    lines: [
      {
        id: LINE_1,
        goodId: GOOD_1,
        quantity: 10,
        price: 100,
        receivedQty: 2,
        good: { unitId: UNIT_ID },
      },
      {
        id: LINE_2,
        goodId: GOOD_2,
        quantity: 5,
        price: 20.5,
        receivedQty: 0,
        good: { unitId: UNIT_ID },
      },
    ],
  };

  // Форма для фінального findOne → toDto.
  const poAfter = {
    ...poWithLines,
    totalAmount: 1102.5,
    paidAmount: 0,
    supplier: { firstName: 'S', lastName: '', companyName: null },
    warehouse: { name: 'W' },
    lines: poWithLines.lines.map(l => ({
      ...l,
      good: { name: 'X', sku: null, unit: 'шт', unitOfMeasure: null },
      unitOfMeasureId: UNIT_ID,
    })),
  };

  const DTO = {
    lines: [
      { lineId: LINE_1, receivedQty: 4 },
      { lineId: LINE_2, receivedQty: 5 },
    ],
  };

  beforeEach(async () => {
    prisma = {
      purchaseOrder: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(poWithLines) // pre-tx читання
          .mockResolvedValueOnce({ status: PurchaseOrderStatus.PARTIAL }) // in-tx re-read статусу
          .mockResolvedValue(poAfter), // фінальний findOne
        update: vi.fn().mockResolvedValue({}),
      },
      purchaseOrderLine: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([
          { id: LINE_1, quantity: 10, receivedQty: 6 },
          { id: LINE_2, quantity: 5, receivedQty: 5 },
        ]),
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
  });

  // guards: BR-PO-005
  it('два рядки → CAS обох рядків ДО першого руху; RECEIPT на кожен рядок; РІВНО ОДИН SUPPLIER_CHARGE на Σ', async () => {
    await service.receive(ORG, PO_ID, DTO, USER_ID);

    // КРОК 1 — CAS: у where стоїть receivedQty, прочитаний ДО транзакції (2 і 0), а не лише id.
    expect(prisma.purchaseOrderLine.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.purchaseOrderLine.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: LINE_1, orgId: ORG, receivedQty: 2 },
        data: expect.objectContaining({ receivedQty: { increment: 4 } }),
      }),
    );
    expect(prisma.purchaseOrderLine.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: LINE_2, orgId: ORG, receivedQty: 0 },
        data: expect.objectContaining({ receivedQty: { increment: 5 } }),
      }),
    );

    // КРОК 2 — рух RECEIPT на кожен прийнятий рядок, у тій самій транзакції (tx = prisma-мок).
    expect(inventory.createMovement).toHaveBeenCalledTimes(2);
    expect(inventory.createMovement).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        type: 'RECEIPT',
        goodId: GOOD_1,
        warehouseId: WAREHOUSE_ID,
        quantity: 4,
        price: 100,
        documentType: 'PurchaseOrder',
        documentId: PO_ID,
      }),
      prisma,
    );
    expect(inventory.createMovement).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ type: 'RECEIPT', goodId: GOOD_2, quantity: 5, price: 20.5 }),
      prisma,
    );

    // Порядок: останній CAS раніше за перший рух.
    const lastCas = Math.max(...prisma.purchaseOrderLine.updateMany.mock.invocationCallOrder);
    const firstMovement = Math.min(...inventory.createMovement.mock.invocationCallOrder);
    expect(lastCas).toBeLessThan(firstMovement);

    // Один борг на весь прийом: 4×100,00 + 5×20,50 = 502,50 (а не по боргу на рядок).
    expect(settlements.createTransaction).toHaveBeenCalledTimes(1);
    expect(settlements.createTransaction).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        type: 'SUPPLIER_CHARGE',
        counterpartyId: SUPPLIER_ID,
        amount: 502.5,
        documentType: 'PurchaseOrder',
        documentId: PO_ID,
      }),
      prisma,
    );
  });

  // guards: BR-PO-005
  it('CAS ДРУГОГО рядка не зійшовся → throw; жодного RECEIPT-руху (і для першого рядка теж) і без SUPPLIER_CHARGE', async () => {
    prisma.purchaseOrderLine.updateMany
      .mockResolvedValueOnce({ count: 1 }) // рядок 1 — ок
      .mockResolvedValueOnce({ count: 0 }); // рядок 2 уже змінив конкурентний receive()

    const err: unknown = await service.receive(ORG, PO_ID, DTO, USER_ID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    // Саме CAS-виняток, а не over-receipt / дубль lineId / зміна статусу (ті кидають свій текст).
    expect((err as Error).message).toMatch(/уже опрацьовано|змінено іншою/i);
    // Виняток вилетів із callback-а транзакції → у реальній БД рядок 1 відкотиться.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(inventory.createMovement).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });
});
