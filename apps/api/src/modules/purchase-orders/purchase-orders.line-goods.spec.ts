/**
 * PurchaseOrdersService — create/update — tenant-guard goodId рядків (validateLineGoodIds)
 *
 * Good.id глобально унікальний, а FK PurchaseOrderLine.goodId не знає про orgId. Без guard-у
 * org A може підсунути goodId org B: рядок створиться, а на receive() `createMovement` запише
 * RECEIPT-рух проти чужого товару (cross-tenant stock-ledger). Тому сервіс ПЕРЕД будь-яким
 * записом звіряє всі goodId рядків із `good.findMany({ orgId, deletedAt: null })` і кидає 404.
 *
 * Мутація, якою доведено кейси: прибрати виклик `validateLineGoodIds` у create() / update() —
 * відповідний кейс падає (документ пишеться, 404 немає).
 *
 * Спільні DI-провайдери — `./purchase-orders.spec-fixture`.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
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

describe('PurchaseOrdersService.create/update — tenant-guard goodId рядків', () => {
  let service: PurchaseOrdersService;
  let prisma: {
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    warehouse: { findFirst: ReturnType<typeof vi.fn> };
    counterpartyContract: { findFirst: ReturnType<typeof vi.fn> };
    good: { findMany: ReturnType<typeof vi.fn> };
    purchaseOrder: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      findFirstOrThrow: ReturnType<typeof vi.fn>;
    };
    purchaseOrderLine: {
      createMany: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let docNumbers: { next: ReturnType<typeof vi.fn> };

  const ORG = 'org-A';
  const PO_ID = '11111111-1111-4111-8111-111111111111';
  const SUP = '22222222-2222-4222-8222-222222222222';
  const WH = '33333333-3333-4333-8333-333333333333';
  const OWN_GOOD = '44444444-4444-4444-8444-444444444444';
  const FOREIGN_GOOD = '55555555-5555-4555-8555-555555555555'; // товар іншої організації

  // Форма, яку приймає toDto, — щоб «зламаний» сервіс (без guard-у) дійшов до кінця і
  // повернув документ, а не впав на побічному TypeError: тоді кейс падає саме через
  // відсутність 404, а не випадково.
  const poRow = {
    id: PO_ID,
    orgId: ORG,
    number: 'PO-LG',
    status: PurchaseOrderStatus.DRAFT,
    supplierId: SUP,
    warehouseId: WH,
    contractId: null,
    totalAmount: 0,
    paidAmount: 0,
    notes: null,
    documentDate: new Date('2026-10-07'),
    createdAt: new Date(),
    updatedAt: new Date(),
    supplier: { firstName: 'S', lastName: '', companyName: null },
    warehouse: { name: 'W' },
    contract: null,
    currency: { code: 'UAH' },
    lines: [],
  };

  const LINES = [
    { goodId: OWN_GOOD, quantity: 2, price: 100 },
    { goodId: FOREIGN_GOOD, quantity: 1, price: 50 },
  ];

  beforeEach(async () => {
    prisma = {
      counterparty: { findFirst: vi.fn().mockResolvedValue({ id: SUP }) },
      warehouse: { findFirst: vi.fn().mockResolvedValue({ id: WH }) },
      counterpartyContract: { findFirst: vi.fn().mockResolvedValue(null) },
      // БД відфільтрувала за orgId: із двох запитаних goodId свій лише один.
      good: { findMany: vi.fn().mockResolvedValue([{ id: OWN_GOOD }]) },
      purchaseOrder: {
        // update(): перший findFirst — narrow guard (DRAFT); далі — findOne/повний рядок.
        findFirst: vi.fn().mockResolvedValue({
          ...poRow,
          trackingNumber: null,
          currencyId: null,
        }),
        create: vi.fn().mockResolvedValue({ id: PO_ID }),
        update: vi.fn().mockResolvedValue(poRow),
        findFirstOrThrow: vi.fn().mockResolvedValue(poRow),
      },
      purchaseOrderLine: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
    };
    docNumbers = { next: vi.fn().mockResolvedValue('PO-LG') };

    const module = await Test.createTestingModule({
      providers: [
        PurchaseOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: {} },
        { provide: SettlementsService, useValue: {} },
        { provide: DocumentNumberService, useValue: docNumbers },
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

  // guards: BR-PO-004
  it('create: goodId рядка з іншої організації → NotFoundException ДО будь-якого запису', async () => {
    const dto = { supplierId: SUP, warehouseId: WH, lines: LINES };

    const err: unknown = await service.create(ORG, dto as never).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotFoundException);
    // Повідомлення називає саме чужий goodId — отже 404 кинув guard рядків, а не сусідній
    // guard постачальника/складу (вони в цьому кейсі проходять).
    expect((err as Error).message).toContain(FOREIGN_GOOD);
    // Пошук товарів обмежений організацією й живими записами.
    expect(prisma.good.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [OWN_GOOD, FOREIGN_GOOD] }, orgId: ORG, deletedAt: null },
      }),
    );
    // «ДО запису»: ні номера документа (лічильник не спалено), ні транзакції, ні рядків.
    expect(docNumbers.next).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.purchaseOrder.create).not.toHaveBeenCalled();
    expect(prisma.purchaseOrderLine.createMany).not.toHaveBeenCalled();
  });

  // guards: BR-PO-004
  it('update: goodId рядка з іншої організації → NotFoundException ДО будь-якого запису', async () => {
    const err: unknown = await service
      .update(ORG, PO_ID, { lines: LINES } as never)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as Error).message).toContain(FOREIGN_GOOD);
    expect(prisma.good.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [OWN_GOOD, FOREIGN_GOOD] }, orgId: ORG, deletedAt: null },
      }),
    );
    // Наявні рядки не soft-delete-нуті, нові не створені, шапка не оновлена.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.purchaseOrderLine.updateMany).not.toHaveBeenCalled();
    expect(prisma.purchaseOrderLine.createMany).not.toHaveBeenCalled();
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  it('update без поля lines → товари не перевіряються (рядки не чіпаються), 404 немає', async () => {
    await expect(service.update(ORG, PO_ID, { notes: 'x' } as never)).resolves.toBeDefined();
    expect(prisma.good.findMany).not.toHaveBeenCalled();
  });
});
