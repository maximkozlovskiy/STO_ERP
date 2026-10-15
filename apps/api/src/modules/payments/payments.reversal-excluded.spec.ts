/**
 * Сторнована оплата більше ніде не рахується (BR-CASH-024): рядок `Payment` лишається в базі
 * (журнал оплат не видаляється), але з `reversedAt` він не входить у суми «сплачено», нічну
 * звірку й фіскальну чергу.
 *
 *   • нічна звірка (`ReconciliationProcessor`): «сплачено» рахунку після сторно = Σ НЕсторнованих
 *     оплат — дрейфу немає; проводка `PAYMENT_CANCEL` повертає борг зі знаком +1;
 *   • обробник фіскальних чеків (`CheckboxProcessor`): чек за сторновану оплату не пробивається,
 *     навіть якщо джоб уже стояв у черзі.
 *
 * Обидва процесори живуть поза модулем `payments`, але правило — про оплату, тож аспект тут.
 * Агрегати (`groupBy`, `findFirst`) відповідають із рядків у пам'яті й застосовують `where`
 * по-справжньому (`whereMatches`): сторнована оплата «зникає» лише якщо запит сервісу її відсіяв.
 *
 * Написано зі специфікації ДО коду.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { Job } from 'bullmq';
import {
  ReconciliationProcessor,
  type ReconcileJob,
} from '../reconciliation/reconciliation.processor';
import { CheckboxProcessor } from './checkbox.processor';
import { ProviderConfigService } from './provider-config.service';
import { CashShiftService } from './cash-shift.service';
import { IntegrationLogService } from '../integration-logs/integration-log.service';
import { DeadLetterService } from '../dead-letter/dead-letter.service';
import { PrismaService } from '../../prisma/prisma.service';
import { memoryTable, whereMatches, type MemRow } from '../cash/cash.spec-fixture';

const ORG = 'org-1';
const INV = 'inv-1';
const REVERSED_AT = new Date('2026-10-14T09:00:00.000Z');

/** `groupBy` поверх рядків у пам'яті: фільтр `where`, групування за `by`, `_sum`. */
function memoryGroupBy(rows: MemRow[]) {
  return vi.fn((args: { by: string[]; where?: unknown; _sum?: Record<string, boolean> }) => {
    const groups = new Map<string, MemRow>();
    for (const row of rows.filter(r => whereMatches(r, args.where))) {
      const key = JSON.stringify(args.by.map(k => row[k]));
      const group =
        groups.get(key) ??
        (() => {
          const g: MemRow = { _sum: {} };
          for (const k of args.by) g[k] = row[k];
          groups.set(key, g);
          return g;
        })();
      const sum = group._sum as Record<string, number>;
      for (const field of Object.keys(args._sum ?? {})) {
        sum[field] = Math.round(((sum[field] ?? 0) + Number(row[field] ?? 0)) * 100) / 100;
      }
    }
    return Promise.resolve([...groups.values()]);
  });
}

describe('ReconciliationProcessor — сторнована оплата не входить у «сплачено» рахунку', () => {
  const job = { data: { orgId: ORG } } as Job<ReconcileJob>;

  function makeRecon(payments: MemRow[], invoicePaid: number, settlementRows: MemRow[] = []) {
    const prisma = {
      stockItem: { findMany: vi.fn().mockResolvedValue([]) },
      stockBatch: { groupBy: vi.fn().mockResolvedValue([]) },
      settlementAccount: { findMany: vi.fn().mockResolvedValue([]) },
      settlementTransaction: { groupBy: memoryGroupBy(settlementRows) },
      invoice: {
        findMany: vi.fn().mockResolvedValue([{ id: INV, paidAmount: invoicePaid }]),
      },
      payment: { groupBy: memoryGroupBy(payments) },
      // Звірка «сплачено» наряду (BR-INV-018): нарядів тут немає.
      workOrder: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const processor = new ReconciliationProcessor(prisma as never, { capture: vi.fn() } as never);
    const errors = vi.spyOn(processor['logger'], 'error');
    return { prisma, processor, errors };
  }

  const pay = (id: string, amount: number, reversedAt: Date | null): MemRow => ({
    id,
    orgId: ORG,
    invoiceId: INV,
    amount,
    reversedAt,
  });

  // Рахунок 500 оплачено двома оплатами (300 + 200); оплату 200 сторновано → «сплачено» 300.
  // Рядок сторнованої оплати лишився — звірка мусить його не рахувати.
  // guards: BR-CASH-024
  it('300 чинна + 200 сторнована, «сплачено» 300 → дрейфу немає', async () => {
    const { processor, errors } = makeRecon(
      [pay('p1', 300, null), pay('p2', 200, REVERSED_AT)],
      300,
    );
    await processor.process(job);
    expect(errors).not.toHaveBeenCalledWith(expect.stringContaining('DRIFT paidAmount'));
  });

  // guards: BR-CASH-024
  it('єдину оплату сторновано, «сплачено» 0 → дрейфу немає', async () => {
    const { processor, errors } = makeRecon([pay('p1', 450.5, REVERSED_AT)], 0);
    await processor.process(job);
    expect(errors).not.toHaveBeenCalledWith(expect.stringContaining('DRIFT paidAmount'));
  });

  // Контроль: відсіювання сторнованих не маскує справжній дрейф.
  // guards: BR-CASH-024
  it('справжній дрейф поруч зі сторнованою оплатою усе ще ловиться', async () => {
    const { processor, errors } = makeRecon(
      [pay('p1', 300, null), pay('p2', 200, REVERSED_AT)],
      500,
    );
    await processor.process(job);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('DRIFT paidAmount'));
  });

  // Баланс контрагента: оплата (−1) і її сторно (+1) взаємно гасяться, борг повертається.
  // guards: BR-CASH-024
  it('баланс: CHARGE 1000, PAYMENT 400, PAYMENT_CANCEL 400 → очікуваний 1000, дрейфу немає', async () => {
    const st = (type: string, amount: number): MemRow => ({
      orgId: ORG,
      settlementAccountId: 'acc-1',
      type,
      amount,
      documentType: 'Payment',
      documentId: 'p1',
    });
    const { prisma, processor, errors } = makeRecon([], 0, [
      st('CHARGE', 1000),
      st('PAYMENT', 400),
      st('PAYMENT_CANCEL', 400),
    ]);
    prisma.settlementAccount.findMany.mockResolvedValue([{ id: 'acc-1', balance: 1000 }]);
    await processor.process(job);
    expect(errors).not.toHaveBeenCalledWith(expect.stringContaining('DRIFT balance'));
  });

  // guards: BR-CASH-024
  it('баланс: аванс і його сторно (PREPAYMENT 300, PREPAYMENT_CANCEL 300) → 0, дрейфу немає', async () => {
    const st = (type: string, amount: number): MemRow => ({
      orgId: ORG,
      settlementAccountId: 'acc-1',
      type,
      amount,
      documentType: 'Payment',
      documentId: 'p1',
    });
    const { prisma, processor, errors } = makeRecon([], 0, [
      st('PREPAYMENT', 300),
      st('PREPAYMENT_CANCEL', 300),
    ]);
    prisma.settlementAccount.findMany.mockResolvedValue([{ id: 'acc-1', balance: 0 }]);
    await processor.process(job);
    expect(errors).not.toHaveBeenCalledWith(expect.stringContaining('DRIFT balance'));
  });
});

describe('CheckboxProcessor — чек за сторновану оплату не пробивається', () => {
  let processor: CheckboxProcessor;
  let paymentRows: MemRow[];
  const sellReceipt = vi.fn();
  const resolveActive = vi.fn();
  const findOpenShift = vi.fn();
  const ensureToken = vi.fn();

  const job = {
    data: { paymentId: 'pay-1', orgId: ORG, branchId: 'br-1', amount: 100, method: 'cash' },
    attemptsMade: 0,
    opts: { attempts: 288 },
  } as unknown as Job<{
    paymentId: string;
    orgId: string;
    branchId: string;
    amount: number;
    method: string;
  }>;

  beforeEach(async () => {
    sellReceipt.mockReset().mockResolvedValue({ fiscalReceiptId: 'fr-1' });
    resolveActive.mockReset().mockResolvedValue({
      provider: 'checkbox',
      apiUrl: 'https://api.checkbox.ua',
      credentials: { licenseKey: 'lic', pinCode: 'pin' },
      shiftMode: 'MANUAL',
    });
    findOpenShift.mockReset().mockResolvedValue({ id: 'shift-1', checkboxShiftId: 'cbx-1' });
    ensureToken.mockReset().mockResolvedValue({
      provider: { code: 'checkbox', sellReceipt },
      cfg: { apiUrl: 'https://api.checkbox.ua', credentials: {} },
      token: 'tok',
    });
    paymentRows = [
      {
        id: 'pay-1',
        orgId: ORG,
        amount: 100,
        fiscalReceiptId: null,
        fiscalStatus: 'QUEUED',
        reversedAt: null,
      },
    ];
    const prisma = { payment: memoryTable(paymentRows) };

    const module = await Test.createTestingModule({
      providers: [
        CheckboxProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: ProviderConfigService, useValue: { resolveActive } },
        {
          provide: CashShiftService,
          useValue: { findOpenShift, open: vi.fn(), ensureToken, refreshToken: vi.fn() },
        },
        {
          provide: IntegrationLogService,
          useValue: { wrap: (_ctx: unknown, fn: () => unknown) => fn() },
        },
        { provide: DeadLetterService, useValue: { capture: vi.fn() } },
      ],
    }).compile();
    processor = module.get(CheckboxProcessor);
    (processor as unknown as { _worker: { name: string } })._worker = { name: 'checkbox' };
  });

  // Контроль harness: несторнована оплата в черзі пробивається.
  // guards: BR-CASH-024
  it('несторнована оплата → чек пробито (контроль)', async () => {
    await processor.process(job);
    expect(sellReceipt).toHaveBeenCalledTimes(1);
  });

  // Сторно поставило SKIPPED, але джоб уже стояв у черзі (або ретраївся) — обробник мусить
  // сам побачити `reversedAt`, а не покладатися на статус.
  // guards: BR-CASH-024
  it('оплату сторновано, джоб уже в черзі → чек НЕ пробито, DONE не записано', async () => {
    paymentRows[0].reversedAt = REVERSED_AT;
    await processor.process(job);
    expect(sellReceipt).not.toHaveBeenCalled();
    expect(paymentRows[0].fiscalStatus).not.toBe('DONE');
    expect(paymentRows[0].fiscalReceiptId).toBeNull();
  });
});
