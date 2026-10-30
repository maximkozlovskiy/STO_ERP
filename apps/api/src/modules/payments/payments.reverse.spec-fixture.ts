/**
 * Спільний harness спеків `PaymentsService.reverse` (BR-CASH-024, BR-PAY-024, BR-PAY-028,
 * BR-INV-025): таблиці в пам'яті, кореневий prisma без запису (лише tx каси), фейкові
 * проводки. Перенесено ДОСЛІВНО з `payments.reverse.spec.ts` (2026-10-31: файл перерос 900 рядків).
 *
 * FACTORY, не `const`: `isolate: false` без `clearMocks`.
 */
import { vi } from 'vitest';
import type { Queue } from 'bullmq';
import { PaymentsService } from './payments.service';
import { exchangeRatesMock } from './payments.spec-fixture';
import { memoryTable, type MemRow } from '../cash/cash.spec-fixture';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SettlementsService } from '../settlements/settlements.service';
import type { WorkOrdersService } from '../work-orders/work-orders.service';
import type { LoyaltyService } from '../loyalty/loyalty.service';
import type { AuditService } from '../audit/audit.service';
import type { CashService } from '../cash/cash.service';
import type { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { domainEventMock } from '../../common/testing/prisma-mock';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
export const CLIENT = 'c0000001-0000-4000-8000-000000000001';
export const USER = '44444444-4444-4444-8444-444444444444';
export const PAY = 'a1000001-0000-4000-8000-000000000001';
export const INV = 'b1000001-0000-4000-8000-000000000001';
export const WO = 'd1000001-0000-4000-8000-000000000001';
export const STORNO_OP = 'e1000001-0000-4000-8000-000000000001';
export const BASE = 'uah-id';

export const CTX = { cashOperationId: STORNO_OP, reason: 'помилка касира', userId: USER };

export interface Seed {
  payment?: MemRow;
  invoice?: MemRow | null;
  workOrder?: MemRow | null;
  /** Тип проводки оригіналу: PAYMENT (за документом) чи PREPAYMENT (аванс). */
  postingType?: string;
  /** Інші проводки журналу ДО сторно (курсова різниця повної оплати тощо). */
  journal?: MemRow[];
}

export function makeHarness(seed: Seed = {}) {
  const payment: MemRow = {
    id: PAY,
    orgId: ORG,
    counterpartyId: CLIENT,
    workOrderId: WO,
    invoiceId: INV,
    amount: 400,
    currencyId: BASE,
    amountBase: 400,
    rateUsed: 1,
    method: 'cash',
    sourceType: 'CASH_REGISTER',
    cashRegisterId: 'r0000001-0000-4000-8000-000000000001',
    fiscalStatus: null,
    fiscalReceiptId: null,
    reversedAt: null,
    reversalCashOperationId: null,
    ...seed.payment,
  };
  const invoice: MemRow | null =
    seed.invoice === null
      ? null
      : {
          id: INV,
          orgId: ORG,
          counterpartyId: CLIENT,
          workOrderId: WO,
          status: 'PAID',
          amount: 1000,
          paidAmount: 1000,
          currencyId: null,
          deletedAt: null,
          ...seed.invoice,
        };
  const workOrder: MemRow | null =
    seed.workOrder === null
      ? null
      : {
          id: WO,
          orgId: ORG,
          counterpartyId: CLIENT,
          status: 'PAID',
          totalAmount: 1000,
          paidAmount: 1000,
          currencyId: null,
          deletedAt: null,
          ...seed.workOrder,
        };

  const tables = {
    // BR-AUT-060: outbox подій — таблиця, що відкочується разом з іншими.

    domainEvent: memoryTable([]),
    payment: memoryTable([payment]),
    invoice: memoryTable(invoice ? [invoice] : []),
    workOrder: memoryTable(workOrder ? [workOrder] : []),
    settlementTransaction: memoryTable([
      {
        id: 'st-orig',
        orgId: ORG,
        settlementAccountId: 'acc-1',
        type: seed.postingType ?? 'PAYMENT',
        amount: payment.amount,
        amountBase: payment.amountBase,
        rateUsed: payment.rateUsed,
        currencyId: payment.currencyId,
        documentType: 'Payment',
        documentId: PAY,
      },
      ...(seed.journal ?? []),
    ]),
    organisationSettings: memoryTable([{ id: 'set-1', orgId: ORG, baseCurrencyId: BASE }]),
    currency: memoryTable([
      { id: BASE, orgId: ORG, code: 'UAH', isBase: true, deletedAt: null },
      { id: 'usd-id', orgId: ORG, code: 'USD', isBase: false, deletedAt: null },
    ]),
  };

  // Кореневий клієнт читати може, ПИСАТИ — ні: запис поза tx каси не відкотився б разом із ним.
  const forbidWrite = (model: string) => () => {
    throw new Error(
      `PaymentsService.reverse пише через this.prisma.${model} — має йти через tx каси`,
    );
  };
  const root: Record<string, unknown> = {
    domainEvent: domainEventMock(),
    $transaction: vi.fn(() => {
      throw new Error('PaymentsService.reverse не відкриває власної транзакції — працює в tx каси');
    }),
  };
  for (const [name, table] of Object.entries(tables)) {
    root[name] = {
      ...table,
      create: vi.fn(forbidWrite(name)),
      update: vi.fn(forbidWrite(name)),
      updateMany: vi.fn(forbidWrite(name)),
      upsert: vi.fn(forbidWrite(name)),
    };
  }
  const tx = { ...tables };

  const settlementRows: MemRow[] = [];
  const settlements = {
    createTransaction: vi.fn((orgId: string, dto: MemRow, client?: unknown) => {
      settlementRows.push({ orgId, ...dto, __tx: client });
      return Promise.resolve();
    }),
  };
  const workOrders = { transition: vi.fn().mockResolvedValue(undefined) };
  const loyalty = {
    queueEarn: vi.fn().mockResolvedValue(undefined),
    reverseEarn: vi.fn().mockResolvedValue(undefined),
  };
  const exchangeRates = exchangeRatesMock();
  exchangeRates.getBaseCurrency.mockResolvedValue({ id: BASE, code: 'UAH' });
  exchangeRates.requireBaseCurrencyId.mockResolvedValue(BASE);
  const checkboxQueue = {
    add: vi.fn(),
    getJob: vi.fn().mockResolvedValue(null),
    remove: vi.fn().mockResolvedValue(undefined),
  };

  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new PaymentsService(
    root as unknown as PrismaService,
    settlements as unknown as SettlementsService,
    workOrders as unknown as WorkOrdersService,
    loyalty as unknown as LoyaltyService,
    audit as unknown as AuditService,
    { createOperation: vi.fn() } as unknown as CashService,
    exchangeRates as unknown as ExchangeRatesService,
    checkboxQueue as unknown as Queue,
  );

  const reverse = (orgId = ORG, paymentId = PAY) =>
    service.reverse(orgId, paymentId, CTX, tx as never);

  return {
    service,
    tables,
    tx,
    settlements,
    settlementRows,
    workOrders,
    loyalty,
    payment,
    invoice,
    workOrder,
    audit,
    reverse,
  };
}

/** Читання повертає знімок рядка на момент «до» — запис іде вже в змінений рядок таблиці. */
export function staleRead(
  table: { findFirst: { mockImplementationOnce: (fn: () => Promise<MemRow>) => unknown } },
  snapshot: MemRow,
): void {
  table.findFirst.mockImplementationOnce(() => Promise.resolve({ ...snapshot }));
}
