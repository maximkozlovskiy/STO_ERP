import { Test } from '@nestjs/testing';
import { PurchaseOrderStatus } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PurchaseOrdersService } from '../purchase-orders.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { InventoryService } from '../../inventory/inventory.service';
import { SettlementsService } from '../../settlements/settlements.service';
import { DocumentNumberService } from '../../document-number/document-number.service';
import { PricingService } from '../../inventory/pricing.service';
import { SettingsService } from '../../settings/settings.service';
import { DeliveryTrackingService } from './delivery-tracking.service';

/**
 * Bug #696 (test-gap): PurchaseOrdersService create/update + trackingNumber enqueue-on-ttn.
 * Доводимо кожну гілку: ЕН вказано→deliveryStatus PENDING + enqueueInitial РІВНО раз;
 * ЕН нема→delivery-поля null + НЕ enqueue; trim ('' →null); update новий/той-самий/очищення/undefined.
 * MUTATION-VERIFY: прибрати `if (createTracking)` перед enqueueInitial → тест «без ЕН» падає;
 * підмінити deliveryStatus:'PENDING' на null → тести «з ЕН» падають.
 */
describe('PurchaseOrdersService — delivery tracking enqueue-on-ttn', () => {
  const ORG = 'org-D';
  const PO_ID = '11111111-1111-4111-8111-111111111111';
  const SUPPLIER = '22222222-2222-4222-8222-222222222222';
  const WAREHOUSE = '44444444-4444-4444-8444-444444444444';

  let service: PurchaseOrdersService;
  let prisma: {
    purchaseOrder: {
      findFirst: ReturnType<typeof vi.fn>;
      findFirstOrThrow: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    purchaseOrderLine: {
      createMany: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    warehouse: { findFirst: ReturnType<typeof vi.fn> };
    counterpartyContract: { findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let enqueueInitial: ReturnType<typeof vi.fn>;

  // toDto-shaped рядок для findFirstOrThrow(create) / update(update).
  const poResult = (over: Record<string, unknown> = {}) => ({
    id: PO_ID,
    orgId: ORG,
    number: 'PO-1',
    status: PurchaseOrderStatus.DRAFT,
    supplierId: SUPPLIER,
    warehouseId: WAREHOUSE,
    contractId: null,
    totalAmount: 0,
    totalVat: 0,
    notes: null,
    documentDate: new Date('2026-09-07'),
    paymentDate: null,
    trackingNumber: null,
    deliveryStatus: null,
    deliveryStatusRaw: null,
    deliveryStatusUpdatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    supplier: { firstName: 'S', lastName: '', companyName: null },
    warehouse: { name: 'W' },
    contract: null,
    lines: [],
    ...over,
  });

  beforeEach(async () => {
    enqueueInitial = vi.fn().mockResolvedValue(undefined);
    prisma = {
      purchaseOrder: {
        findFirst: vi.fn(),
        findFirstOrThrow: vi.fn().mockResolvedValue(poResult()),
        create: vi.fn().mockResolvedValue({ id: PO_ID }),
        update: vi.fn().mockResolvedValue(poResult()),
      },
      purchaseOrderLine: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      counterparty: { findFirst: vi.fn().mockResolvedValue({ id: SUPPLIER }) },
      warehouse: { findFirst: vi.fn().mockResolvedValue({ id: WAREHOUSE }) },
      counterpartyContract: { findFirst: vi.fn().mockResolvedValue(null) },
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
        { provide: DocumentNumberService, useValue: { next: vi.fn().mockResolvedValue('PO-1') } },
        { provide: PricingService, useValue: {} },
        {
          provide: SettingsService,
          useValue: {
            getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }),
          },
        },
        { provide: DeliveryTrackingService, useValue: { enqueueInitial } },
      ],
    }).compile();
    service = module.get(PurchaseOrdersService);
  });

  // ─── create ──────────────────────────────────────────────────────────────

  it('create з ЕН → deliveryStatus PENDING + deliveryStatusUpdatedAt set + enqueueInitial РІВНО раз', async () => {
    await service.create(ORG, {
      supplierId: SUPPLIER,
      warehouseId: WAREHOUSE,
      trackingNumber: '20450000000001',
    });
    const data = prisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.trackingNumber).toBe('20450000000001');
    expect(data.deliveryStatus).toBe('PENDING');
    expect(data.deliveryStatusUpdatedAt).toBeInstanceOf(Date);
    expect(enqueueInitial).toHaveBeenCalledTimes(1);
    expect(enqueueInitial).toHaveBeenCalledWith(ORG, PO_ID);
  });

  it('create БЕЗ ЕН → delivery-поля null + enqueueInitial НЕ викликано (MUTATION: прибрати if(createTracking))', async () => {
    await service.create(ORG, { supplierId: SUPPLIER, warehouseId: WAREHOUSE });
    const data = prisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.trackingNumber).toBeNull();
    expect(data.deliveryStatus).toBeNull();
    expect(data.deliveryStatusUpdatedAt).toBeNull();
    expect(enqueueInitial).not.toHaveBeenCalled();
  });

  it('create з ЕН у пробілах → normalizeTracking trim + enqueue', async () => {
    await service.create(ORG, {
      supplierId: SUPPLIER,
      warehouseId: WAREHOUSE,
      trackingNumber: '  204  ',
    });
    expect(prisma.purchaseOrder.create.mock.calls[0][0].data.trackingNumber).toBe('204');
    expect(enqueueInitial).toHaveBeenCalledTimes(1);
  });

  it('create з ЕН лише пробіли → normalizeTracking → null, НЕ enqueue', async () => {
    await service.create(ORG, {
      supplierId: SUPPLIER,
      warehouseId: WAREHOUSE,
      trackingNumber: '   ',
    });
    const data = prisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.trackingNumber).toBeNull();
    expect(data.deliveryStatus).toBeNull();
    expect(enqueueInitial).not.toHaveBeenCalled();
  });

  it('create toDto повертає всі 4 delivery-поля', async () => {
    prisma.purchaseOrder.findFirstOrThrow.mockResolvedValue(
      poResult({
        trackingNumber: '204',
        deliveryStatus: 'PENDING',
        deliveryStatusRaw: 'очікує',
        deliveryStatusUpdatedAt: new Date('2026-09-07T10:00:00Z'),
      }),
    );
    const dto = await service.create(ORG, {
      supplierId: SUPPLIER,
      warehouseId: WAREHOUSE,
      trackingNumber: '204',
    });
    expect(dto.trackingNumber).toBe('204');
    expect(dto.deliveryStatus).toBe('PENDING');
    expect(dto.deliveryStatusRaw).toBe('очікує');
    expect(dto.deliveryStatusUpdatedAt).toBe('2026-09-07T10:00:00.000Z');
  });

  // ─── update ──────────────────────────────────────────────────────────────

  const draftPo = (over: Record<string, unknown> = {}) => ({
    status: PurchaseOrderStatus.DRAFT,
    totalAmount: 0,
    supplierId: SUPPLIER,
    contractId: null,
    trackingNumber: null,
    ...over,
  });

  it('update новий ЕН → deliveryStatus PENDING + deliveryStatusRaw:null (скид стейл) + enqueue', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue(draftPo({ trackingNumber: null }));
    await service.update(ORG, PO_ID, { trackingNumber: '204NEW' });
    const data = prisma.purchaseOrder.update.mock.calls[0][0].data;
    expect(data.trackingNumber).toBe('204NEW');
    expect(data.deliveryStatus).toBe('PENDING');
    expect(data.deliveryStatusRaw).toBeNull();
    expect(data.deliveryStatusUpdatedAt).toBeInstanceOf(Date);
    expect(enqueueInitial).toHaveBeenCalledWith(ORG, PO_ID);
  });

  it('update очищення ЕН (null) → усі delivery-поля null + enqueue НЕ (poll-guard зупинить job)', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue(draftPo({ trackingNumber: '204OLD' }));
    await service.update(ORG, PO_ID, { trackingNumber: null });
    const data = prisma.purchaseOrder.update.mock.calls[0][0].data;
    expect(data.trackingNumber).toBeNull();
    expect(data.deliveryStatus).toBeNull();
    expect(data.deliveryStatusRaw).toBeNull();
    expect(data.deliveryStatusUpdatedAt).toBeNull();
    expect(enqueueInitial).not.toHaveBeenCalled();
  });

  it('update очищення ЕН (порожній рядок) → усі delivery-поля null + НЕ enqueue', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue(draftPo({ trackingNumber: '204OLD' }));
    await service.update(ORG, PO_ID, { trackingNumber: '   ' });
    const data = prisma.purchaseOrder.update.mock.calls[0][0].data;
    expect(data.trackingNumber).toBeNull();
    expect(data.deliveryStatus).toBeNull();
    expect(enqueueInitial).not.toHaveBeenCalled();
  });

  it('update той самий ЕН → жодного delivery-write + НЕ enqueue (не рестартуємо трекінг)', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue(draftPo({ trackingNumber: '204SAME' }));
    await service.update(ORG, PO_ID, { trackingNumber: '204SAME' });
    const data = prisma.purchaseOrder.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('trackingNumber');
    expect(data).not.toHaveProperty('deliveryStatus');
    expect(enqueueInitial).not.toHaveBeenCalled();
  });

  it('update той самий ЕН з пробілами (normalize match) → no-op delivery', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue(draftPo({ trackingNumber: '204SAME' }));
    await service.update(ORG, PO_ID, { trackingNumber: '  204SAME  ' });
    expect(prisma.purchaseOrder.update.mock.calls[0][0].data).not.toHaveProperty('deliveryStatus');
    expect(enqueueInitial).not.toHaveBeenCalled();
  });

  it('update без поля trackingNumber (undefined) → delivery-поля НЕ чіпаються + НЕ enqueue', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue(draftPo({ trackingNumber: '204EXISTING' }));
    await service.update(ORG, PO_ID, { notes: 'зміна опису' });
    const data = prisma.purchaseOrder.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('trackingNumber');
    expect(data).not.toHaveProperty('deliveryStatus');
    expect(data).not.toHaveProperty('deliveryStatusRaw');
    expect(enqueueInitial).not.toHaveBeenCalled();
  });

  it('update очищення коли ЕН вже був null → no-op (жодного spurious delivery-write)', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue(draftPo({ trackingNumber: null }));
    await service.update(ORG, PO_ID, { trackingNumber: '' });
    expect(prisma.purchaseOrder.update.mock.calls[0][0].data).not.toHaveProperty('deliveryStatus');
    expect(enqueueInitial).not.toHaveBeenCalled();
  });

  it('update поза DRAFT (ORDERED) з ЕН → BadRequest ПЕРЕД trackingUpdate + жоден write/enqueue', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue(
      draftPo({ status: PurchaseOrderStatus.ORDERED, trackingNumber: null }),
    );
    await expect(service.update(ORG, PO_ID, { trackingNumber: '204' })).rejects.toThrow(
      /лише чернетку/,
    );
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
    expect(enqueueInitial).not.toHaveBeenCalled();
  });
});
