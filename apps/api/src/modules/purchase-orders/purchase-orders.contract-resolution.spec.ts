/**
 * PurchaseOrdersService — update — резолв контракту контрагента
 *
 * Виділено з `purchase-orders.service.spec.ts` (був 1960 рядків, 7 незалежних
 * describe-блоків) 2026-10-05. Кейси перенесені ДОСЛІВНО, жоден it() не змінено:
 * сумарна кількість до і після розбиття — 55, перевірено раннером.
 *
 * Спільні DI-провайдери — `./purchase-orders.spec-fixture`.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { NotFoundException, BadRequestException } from '@nestjs/common';
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

describe('PurchaseOrdersService.update — contract resolution', () => {
  let service: PurchaseOrdersService;
  let prisma: {
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    purchaseOrderLine: {
      updateMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
    };
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    warehouse: { findFirst: ReturnType<typeof vi.fn> };
    counterpartyContract: { findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };

  const ORG = 'org-A';
  const PO_ID = '11111111-1111-4111-8111-111111111111';
  const OLD_SUPPLIER = '22222222-2222-4222-8222-222222222222';
  const NEW_SUPPLIER = '33333333-3333-4333-8333-333333333333';
  const WAREHOUSE = '44444444-4444-4444-8444-444444444444';
  const NEW_WAREHOUSE = '55555555-5555-4555-8555-555555555555';
  const OLD_CONTRACT = '66666666-6666-4666-8666-666666666666';
  const NEW_CONTRACT = '77777777-7777-4777-8777-777777777777';

  // toDto-shaped result for tx.purchaseOrder.update().include
  const updateResult = {
    id: PO_ID,
    orgId: ORG,
    number: 'PO-RX',
    status: PurchaseOrderStatus.DRAFT,
    supplierId: NEW_SUPPLIER,
    warehouseId: WAREHOUSE,
    contractId: null,
    totalAmount: 0,
    notes: null,
    documentDate: new Date('2026-06-15'),
    createdAt: new Date(),
    updatedAt: new Date(),
    supplier: { firstName: 'S', lastName: '', companyName: null },
    warehouse: { name: 'W' },
    contract: null,
    lines: [],
  };

  beforeEach(async () => {
    prisma = {
      purchaseOrder: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue(updateResult),
      },
      purchaseOrderLine: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      counterparty: { findFirst: vi.fn() },
      warehouse: { findFirst: vi.fn() },
      counterpartyContract: { findFirst: vi.fn() },
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        PurchaseOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: {} },
        { provide: SettlementsService, useValue: {} },
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
  });

  const draftPo = (overrides: Partial<{ supplierId: string; contractId: string | null }> = {}) => ({
    status: PurchaseOrderStatus.DRAFT,
    totalAmount: 0,
    supplierId: overrides.supplierId ?? OLD_SUPPLIER,
    // Use `in` check замість `??` — `null` is a valid override value (po має null contractId)
    contractId: 'contractId' in overrides ? overrides.contractId! : OLD_CONTRACT,
  });

  // Bug #473 — критичний regression-guard для commit 32c6115f.
  // Branch 3: supplierChanged && po.contractId → newContractId = null (auto-clear stale).
  it('Bug #473: supplier changed without contractId у dto → auto-clear stale contract', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(draftPo());
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: NEW_SUPPLIER });

    await service.update(ORG, PO_ID, { supplierId: NEW_SUPPLIER });

    expect(prisma.counterpartyContract.findFirst).not.toHaveBeenCalled();
    expect(prisma.purchaseOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PO_ID, orgId: ORG },
        data: expect.objectContaining({
          supplierId: NEW_SUPPLIER,
          contractId: null,
        }),
      }),
    );
  });

  // Bug #473 — guard має НЕ спрацювати коли po.contractId уже null
  it('Bug #473: supplier changed коли po.contractId уже null → contractId не явно clear (undefined)', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(draftPo({ contractId: null }));
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: NEW_SUPPLIER });

    await service.update(ORG, PO_ID, { supplierId: NEW_SUPPLIER });

    // Якщо po.contractId уже null → не треба auto-clear: Branch 3 не спрацьовує.
    // newContractId залишається undefined → Prisma trivially no-op.
    const updateCall = prisma.purchaseOrder.update.mock.calls[0][0];
    expect(updateCall.data.supplierId).toBe(NEW_SUPPLIER);
    expect(updateCall.data.contractId).toBeUndefined();
  });

  // Bug #474 — explicit clear (contractId=null від frontend після ручного зняття договору)
  it('Bug #474: explicit contractId=null → newContractId=null persisted без validation запиту', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(draftPo());

    await service.update(ORG, PO_ID, { contractId: null });

    // Не робить validation запиту — null обходить findFirst для contract
    expect(prisma.counterpartyContract.findFirst).not.toHaveBeenCalled();
    expect(prisma.purchaseOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contractId: null,
        }),
      }),
    );
  });

  // Bug #475 — cross-org supplierId rejection
  it('Bug #475: cross-org supplierId → NotFoundException, жоден write', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(draftPo());
    // findFirst returns null → supplier у іншій org
    prisma.counterparty.findFirst.mockResolvedValueOnce(null);

    await expect(service.update(ORG, PO_ID, { supplierId: NEW_SUPPLIER })).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.counterparty.findFirst).toHaveBeenCalledWith({
      where: { id: NEW_SUPPLIER, orgId: ORG, deletedAt: null },
      select: { id: true, type: true },
    });
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  // guards: BR-CP-001
  it('зміна постачальника на контрагента-клієнта → BadRequestException, жоден write', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(draftPo());
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: NEW_SUPPLIER, type: 'CLIENT' });

    await expect(service.update(ORG, PO_ID, { supplierId: NEW_SUPPLIER })).rejects.toThrow(
      'Контрагент не є постачальником',
    );
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  // Bug #475 — cross-org warehouseId rejection
  it('Bug #475: cross-org warehouseId → NotFoundException, жоден write', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(draftPo());
    prisma.warehouse.findFirst.mockResolvedValueOnce(null);

    await expect(service.update(ORG, PO_ID, { warehouseId: NEW_WAREHOUSE })).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.warehouse.findFirst).toHaveBeenCalledWith({
      where: { id: NEW_WAREHOUSE, orgId: ORG, deletedAt: null },
      select: { id: true },
    });
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  // Bug #476 — cross-supplier contractId rejection (Branch 1 валідує counterpartyId=effective)
  it('Bug #476: contractId з іншого постачальника → NotFoundException, жоден write', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(draftPo());
    // supplier valid
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: NEW_SUPPLIER });
    // contract findFirst returns null (contract belongs to інший supplier)
    prisma.counterpartyContract.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.update(ORG, PO_ID, {
        supplierId: NEW_SUPPLIER,
        contractId: NEW_CONTRACT,
      }),
    ).rejects.toThrow(NotFoundException);

    // ОБОВ'ЯЗКОВО валідує counterpartyId = effectiveSupplierId
    expect(prisma.counterpartyContract.findFirst).toHaveBeenCalledWith({
      where: {
        id: NEW_CONTRACT,
        orgId: ORG,
        counterpartyId: NEW_SUPPLIER, // effectiveSupplierId = dto.supplierId
        contractType: 'PURCHASE',
        deletedAt: null,
      },
      select: { id: true },
    });
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  // Bug #476 supplementary — valid contractId передано → встановлюється
  it('Bug #476: valid contractId передано → встановлюється, validate проти effective supplier', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(draftPo());
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: NEW_SUPPLIER });
    prisma.counterpartyContract.findFirst.mockResolvedValueOnce({ id: NEW_CONTRACT });

    await service.update(ORG, PO_ID, {
      supplierId: NEW_SUPPLIER,
      contractId: NEW_CONTRACT,
    });

    expect(prisma.purchaseOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          supplierId: NEW_SUPPLIER,
          contractId: NEW_CONTRACT,
        }),
      }),
    );
  });

  // Defense — guard not on DRAFT
  it('non-DRAFT PO → BadRequestException, жоден write', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      ...draftPo(),
      status: PurchaseOrderStatus.ORDERED,
    });

    await expect(service.update(ORG, PO_ID, { notes: 'x' })).rejects.toThrow(BadRequestException);
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });
});

// Bug #481: regression guards для transition() — FSM map PO_TRANSITIONS + assertFsmTransition.
// Commit 115fea9e (feat(purchase-orders): show all fields, editable supplier/warehouse/contract
// in DRAFT, FSM arrows always visible) виставив "FSM arrows always visible" у фронті — без
// будь-яких backend unit-тестів на FSM-перехід. Видалення PO_TRANSITIONS[STATE] = [...]
// або заміна assertFsmTransition на голий tx.update({ status }) пройде CI зеленим,
// runtime отримає silently corrupted FSM (можна перевести RECEIVED→DRAFT без error).
// Без цих guards: майбутній refactor FSM-map або "FSM arrows always visible" feature
// (commit 115fea9e) може посилати недозволений status зі фронту → бекенд silently апдейтить
// → broken invariant.
