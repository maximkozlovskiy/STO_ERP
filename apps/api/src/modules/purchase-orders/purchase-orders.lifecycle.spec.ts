/**
 * Замовлення постачальнику — наслідки статусу й заміни рядків чернетки в ОДНОМУ місці
 * (`purchase-order-lifecycle.ts`, BR-PO-010).
 *
 * Хуки списків купівлі колись підключались у кожному місці виклику окремо, і перехід «Отримано»
 * свій забув: позиції лишались ORDERED на закритому замовленні. Тут два сторожі:
 *  - поведінка: кожен шлях закриття (скасування, «Отримано», повне приймання, видалення) кличе
 *    `onOrderClosed` рівно раз і ДО запису рядка замовлення (порядок блокувань «позиції →
 *    замовлення»); заміна рядків — картка і імпорт XLSX — одна послідовність записів;
 *  - вихідний код: хуки замовлення й запис статусу замовлення стоять лише в модулі життєвого
 *    циклу — новий шлях, що підключить хук сам (або забуде), стає червоним тестом.
 *
 * Мутації, якими доведено кейси: (1) прибрано `closeOrderForPurchaseLists` із `setStatus` —
 * червоні «скасування», «Отримано», «повне приймання» (і 11 кейсів `purchase-lists.po-lifecycle`);
 * (2) хук перенесено після CAS у `setStatus` — червоні ті самі три за `invocationCallOrder`;
 * (3) у `replaceDraftLines` звірку перенесено перед `createMany` — червоний кейс заміни рядків;
 * (4) у `remove` прямий `this.purchaseLists.onOrderClosed` замість помічника — червоний перепис
 * хуків; (5) `status` у soft delete `remove` — червоний перепис записів статусу.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { vi, describe, it, expect, beforeEach } from 'vitest';
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
import { PurchaseListLinkService } from '../purchase-lists/purchase-list-link.service';
import { PurchaseListReceiptService } from '../purchase-lists/purchase-list-receipt.service';
import { SupplierOrderOutboxService } from '../supplier-api/outbox/supplier-order-outbox.service';
import { PurchaseOrderImportAdapter } from '../xlsx/document-line-import.adapter';
import type { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { exchangeRatesProvider, purchaseListProviders } from './purchase-orders.spec-fixture';
import { domainEventMock } from '../../common/testing/prisma-mock';

const ORG = 'org-life';
const PO_ID = '99999999-9999-4999-8999-999999999999';
const LINE_ID = '99999999-9999-4999-8999-999999999990';
const GOOD_1 = '99999999-9999-4999-8999-999999999991';
const GOOD_2 = '99999999-9999-4999-8999-999999999992';
const WH = '99999999-9999-4999-8999-999999999993';

type Fn = ReturnType<typeof vi.fn>;

const poRead = {
  id: PO_ID,
  orgId: ORG,
  number: 'ЗП-LIFE',
  status: PurchaseOrderStatus.DRAFT,
  supplierId: 'sup',
  warehouseId: WH,
  contractId: null,
  totalAmount: 0,
  paidAmount: 0,
  paymentDate: null,
  currencyId: null,
  trackingNumber: null,
  notes: null,
  documentDate: new Date('2026-11-05'),
  createdAt: new Date(),
  updatedAt: new Date(),
  supplier: { firstName: 'S', lastName: '', companyName: null },
  warehouse: { name: 'W' },
  contract: null,
  lines: [] as unknown[],
};

describe('PurchaseOrdersService — хуки списків купівлі через модуль життєвого циклу', () => {
  let service: PurchaseOrdersService;
  let prisma: {
    purchaseOrder: { findFirst: Fn; updateMany: Fn; update: Fn };
    purchaseOrderLine: { updateMany: Fn; createMany: Fn; findMany: Fn };
    good: { findMany: Fn };
    warehouse: { findFirst: Fn };
    unitOfMeasure: { findMany: Fn };
    goodUoM: { findMany: Fn };
    domainEvent: ReturnType<typeof domainEventMock>;
    $transaction: Fn;
  };
  let lists: { onOrderClosed: Fn; reconcileDraftOrder: Fn };
  let receipt: { allocateOnReceipt: Fn };
  let outbox: { assertCancellable: Fn };

  beforeEach(async () => {
    prisma = {
      purchaseOrder: {
        findFirst: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue(poRead),
      },
      purchaseOrderLine: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      good: {
        findMany: vi.fn().mockResolvedValue([{ id: GOOD_1 }, { id: GOOD_2 }]),
      },
      warehouse: { findFirst: vi.fn().mockResolvedValue(null) },
      unitOfMeasure: { findMany: vi.fn().mockResolvedValue([]) },
      goodUoM: { findMany: vi.fn().mockResolvedValue([]) },
      domainEvent: domainEventMock(),
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        PurchaseOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: { createMovement: vi.fn() } },
        { provide: SettlementsService, useValue: { createTransaction: vi.fn() } },
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
        ...purchaseListProviders(),
      ],
    }).compile();
    service = module.get(PurchaseOrdersService);
    lists = module.get(PurchaseListLinkService);
    receipt = module.get(PurchaseListReceiptService);
    outbox = module.get(SupplierOrderOutboxService);
  });

  /** Хук закриття — рівно раз, у транзакції виклику, до запису рядка замовлення. */
  function expectClosedOnceBeforeWrite(write: Fn): void {
    expect(lists.onOrderClosed).toHaveBeenCalledTimes(1);
    expect(lists.onOrderClosed).toHaveBeenCalledWith(prisma, ORG, PO_ID);
    expect(write).toHaveBeenCalledTimes(1);
    expect(lists.onOrderClosed.mock.invocationCallOrder[0]).toBeLessThan(
      write.mock.invocationCallOrder[0]!,
    );
  }

  // guards: BR-PL-010
  it('скасування: позиції повертаються рівно раз — після перевірки передачі в API, до CAS статусу', async () => {
    prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce({ status: PurchaseOrderStatus.ORDERED })
      .mockResolvedValueOnce(poRead);

    await service.transition(ORG, PO_ID, PurchaseOrderStatus.CANCELLED);

    expectClosedOnceBeforeWrite(prisma.purchaseOrder.updateMany);
    expect(outbox.assertCancellable.mock.invocationCallOrder[0]).toBeLessThan(
      lists.onOrderClosed.mock.invocationCallOrder[0]!,
    );
    expect(prisma.purchaseOrder.updateMany).toHaveBeenCalledWith({
      where: { id: PO_ID, orgId: ORG, deletedAt: null, status: PurchaseOrderStatus.ORDERED },
      data: { status: PurchaseOrderStatus.CANCELLED },
    });
  });

  // guards: BR-PL-012
  it('перехід «Отримано» без приймання: позиції повертаються рівно раз і до CAS статусу', async () => {
    prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce({ status: PurchaseOrderStatus.PARTIAL })
      .mockResolvedValueOnce(poRead);

    await service.transition(ORG, PO_ID, PurchaseOrderStatus.RECEIVED);

    expectClosedOnceBeforeWrite(prisma.purchaseOrder.updateMany);
    expect(outbox.assertCancellable).not.toHaveBeenCalled();
  });

  // guards: BR-PL-010, BR-PL-012
  it.each([
    [PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.ORDERED],
    [PurchaseOrderStatus.ORDERED, PurchaseOrderStatus.PARTIAL],
  ])('перехід %s → %s замовлення не закриває: позиції не чіпаються', async (from, to) => {
    prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce({ status: from })
      .mockResolvedValueOnce(poRead);

    await service.transition(ORG, PO_ID, to);

    expect(lists.onOrderClosed).not.toHaveBeenCalled();
    expect(prisma.purchaseOrder.updateMany).toHaveBeenCalledTimes(1);
  });

  /** Замовлення з одним рядком: 10 замовлено, 4 уже прийнято. */
  function arrangeReceive(receivedAfter: number) {
    prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce({
        ...poRead,
        status: PurchaseOrderStatus.PARTIAL,
        contract: null,
        lines: [
          { id: LINE_ID, goodId: GOOD_1, quantity: 10, price: 5, receivedQty: 4, good: null },
        ],
      })
      .mockResolvedValueOnce({ status: PurchaseOrderStatus.PARTIAL })
      .mockResolvedValue(poRead);
    prisma.purchaseOrderLine.findMany.mockResolvedValue([
      { id: LINE_ID, quantity: 10, receivedQty: receivedAfter },
    ]);
  }

  // guards: BR-PL-012
  it('повне приймання: остача позицій повертається рівно раз — після розподілу отриманого, до CAS статусу', async () => {
    arrangeReceive(10);

    await service.receive(ORG, PO_ID, { lines: [{ lineId: LINE_ID, receivedQty: 6 }] });

    expectClosedOnceBeforeWrite(prisma.purchaseOrder.updateMany);
    // Хук читає `receivedQty` позицій — його записує розподіл, тож розподіл іде раніше.
    expect(receipt.allocateOnReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      lists.onOrderClosed.mock.invocationCallOrder[0]!,
    );
    expect(prisma.purchaseOrder.updateMany).toHaveBeenCalledWith({
      where: { id: PO_ID, orgId: ORG, deletedAt: null, status: PurchaseOrderStatus.PARTIAL },
      data: { status: PurchaseOrderStatus.RECEIVED },
    });
  });

  // guards: BR-PL-012
  it('часткове приймання замовлення не закриває: позиції не повертаються', async () => {
    arrangeReceive(7);

    await service.receive(ORG, PO_ID, { lines: [{ lineId: LINE_ID, receivedQty: 3 }] });

    expect(lists.onOrderClosed).not.toHaveBeenCalled();
    expect(prisma.purchaseOrder.updateMany).toHaveBeenCalledTimes(1);
  });

  // guards: BR-PL-010
  it('видалення чернетки: позиції повертаються рівно раз і до soft delete замовлення', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ status: PurchaseOrderStatus.DRAFT });

    await service.remove(ORG, PO_ID);

    expectClosedOnceBeforeWrite(prisma.purchaseOrder.updateMany);
    expect(prisma.purchaseOrder.updateMany).toHaveBeenCalledWith({
      where: { id: PO_ID, orgId: ORG, deletedAt: null, status: PurchaseOrderStatus.DRAFT },
      data: { deletedAt: expect.any(Date) },
    });
  });

  const twoLines = [
    { goodId: GOOD_1, quantity: 2, price: 10 },
    { goodId: GOOD_2, quantity: 1, price: 30 },
  ];

  /** Записи заміни рядків у порядку виклику: soft delete → нові рядки → звірка → замовлення. */
  function expectReplaceSequence(poWrite: Fn): void {
    const order = [
      prisma.purchaseOrderLine.updateMany.mock.invocationCallOrder[0]!,
      prisma.purchaseOrderLine.createMany.mock.invocationCallOrder[0]!,
      lists.reconcileDraftOrder.mock.invocationCallOrder[0]!,
      poWrite.mock.invocationCallOrder[0]!,
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(lists.reconcileDraftOrder).toHaveBeenCalledTimes(1);
  }

  /** Дані `createMany` без міток часу (їх перевіряє BR-PO-016). */
  function createdRows(): unknown[] {
    const data = (prisma.purchaseOrderLine.createMany.mock.calls[0]![0] as { data: object[] }).data;
    return data.map(row => {
      const { createdAt, ...rest } = row as { createdAt: unknown };
      expect(createdAt).toBeInstanceOf(Date);
      return rest;
    });
  }

  // guards: BR-PL-009
  it('заміна рядків у картці (PATCH) і в імпорті XLSX — одна послідовність записів і ті самі рядки', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ ...poRead });
    await service.update(ORG, PO_ID, { lines: twoLines } as never);

    expectReplaceSequence(prisma.purchaseOrder.update);
    expect(prisma.purchaseOrderLine.updateMany).toHaveBeenCalledWith({
      where: { purchaseOrderId: PO_ID, orgId: ORG },
      data: { deletedAt: expect.any(Date) },
    });
    // Картка передає склад замовлення — звірка відсікає позиції іншого складу.
    expect(lists.reconcileDraftOrder).toHaveBeenCalledWith(prisma, ORG, PO_ID, WH);
    const fromCard = createdRows();

    // Той самий набір рядків через адаптер імпорту — на тих самих фейках.
    vi.clearAllMocks();
    const adapter = new PurchaseOrderImportAdapter(
      {} as PrismaService,
      {
        getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }),
      } as unknown as SettingsService,
      {
        resolveBaseConversion: vi.fn().mockResolvedValue({ amountBase: 50, rateUsed: 1 }),
      } as unknown as ExchangeRatesService,
      lists as unknown as PurchaseListLinkService,
    );
    const tx = {
      ...prisma,
      purchaseOrder: {
        ...prisma.purchaseOrder,
        findFirstOrThrow: vi.fn().mockResolvedValue({ currencyId: 'c', documentDate: null }),
      },
    };
    await adapter.replaceLines(tx as never, ORG, PO_ID, twoLines);

    expectReplaceSequence(prisma.purchaseOrder.updateMany);
    expect(lists.reconcileDraftOrder).toHaveBeenCalledWith(tx, ORG, PO_ID);
    expect(createdRows()).toEqual(fromCard);
  });

  // guards: BR-PL-009
  it('зміна лише складу чернетки: рядки не переписуються, позиції звіряються до запису замовлення', async () => {
    const WH_NEW = '99999999-9999-4999-8999-999999999994';
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ ...poRead });
    prisma.warehouse.findFirst.mockResolvedValueOnce({ id: WH_NEW });

    await service.update(ORG, PO_ID, { warehouseId: WH_NEW } as never);

    expect(prisma.purchaseOrderLine.updateMany).not.toHaveBeenCalled();
    expect(prisma.purchaseOrderLine.createMany).not.toHaveBeenCalled();
    expect(lists.reconcileDraftOrder).toHaveBeenCalledWith(prisma, ORG, PO_ID, WH_NEW);
    expect(lists.reconcileDraftOrder.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.purchaseOrder.update.mock.invocationCallOrder[0]!,
    );
  });
});

// ─── Сторож вихідного коду ────────────────────────────────────────────────────

const SRC = join(__dirname, '..', '..');
const LIFECYCLE = 'modules/purchase-orders/purchase-order-lifecycle.ts';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(name) && !/\.(spec|test)\.ts$|spec-fixture\.ts$|\.d\.ts$/.test(name)
      ? [full]
      : [];
  });
}

/** Текст від `(` до парної `)`. */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if ('({['.includes(text[i]!)) depth++;
    else if (')}]'.includes(text[i]!)) {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

const sources = sourceFiles(SRC).map(full => ({
  file: relative(SRC, full).split(sep).join('/'),
  text: readFileSync(full, 'utf8'),
}));

describe('життєвий цикл замовлення — хуки й статус лише в одному модулі (сторож коду)', () => {
  // guards: BR-PO-010
  it('хуки замовлення (`onOrderClosed`, `reconcileDraftOrder`) поза модулем списків кличе лише модуль життєвого циклу', () => {
    const hits = sources
      .filter(s => !s.file.startsWith('modules/purchase-lists/'))
      .flatMap(s =>
        [...s.text.matchAll(/\.(onOrderClosed|reconcileDraftOrder)\(/g)].map(
          m => `${s.file}::${m[1]}`,
        ),
      )
      .sort();
    expect(hits).toEqual([
      `${LIFECYCLE}::onOrderClosed`,
      `${LIFECYCLE}::reconcileDraftOrder`,
      `${LIFECYCLE}::reconcileDraftOrder`,
    ]);
  });

  // guards: BR-PO-010
  it('статус замовлення (`purchaseOrder.update*` з `status`) пише лише `setStatus`', () => {
    const hits = sources.flatMap(s =>
      [...s.text.matchAll(/\.purchaseOrder\.(update|updateMany)\(/g)]
        .filter(m => {
          const call = balanced(s.text, (m.index ?? 0) + m[0].length - 1);
          const at = call.search(/\bdata\s*:\s*\{/);
          // `data` не літерал — не прочитати: вважаємо записом статусу (fail-closed).
          if (at < 0) return true;
          return /(^|[^\w.])status\s*:/.test(balanced(call, call.indexOf('{', at)));
        })
        .map(m => `${s.file}::${m[1]}`),
    );
    expect(hits).toEqual([`${LIFECYCLE}::updateMany`]);
  });
});
