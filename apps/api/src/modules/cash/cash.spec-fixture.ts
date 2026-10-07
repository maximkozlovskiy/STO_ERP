/**
 * Спільний harness для аспектних спеків CashService (tenant, запис операції).
 *
 * `makeMocks` / `makeService` СКОПІЙОВАНО з `cash.service.spec.ts` (той файл лишає власну
 * копію — його не чіпали, щоб не рухати наявні кейси). FACTORY, не `const`:
 * `vitest.config.ts` має `isolate: false` без `clearMocks`, тож module-level `vi.fn()` жив би
 * спільно для всіх спеків воркера.
 *
 * DI-DRIFT GUARD: нова залежність у конструкторі CashService правиться тут.
 */
import { vi } from 'vitest';
import { CashService } from './cash.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const REG = '22222222-2222-4222-8222-222222222222';
export const USER = '44444444-4444-4444-8444-444444444444';

/** Рядок CashOperation, який «повертає БД» після create. */
export function opRow(over: Record<string, unknown> = {}) {
  return {
    id: 'op-1',
    cashRegisterId: REG,
    cashShiftId: null,
    direction: 'IN',
    amount: 500,
    reason: 'MANUAL_IN',
    expenseCategoryId: null,
    counterpartyId: null,
    employeeId: null,
    documentType: null,
    documentId: null,
    notes: null,
    createdAt: new Date('2026-10-08T09:00:00.000Z'),
    expenseCategory: null,
    ...over,
  };
}

export function makeMocks() {
  return {
    prisma: {
      cashRegister: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        findFirstOrThrow: vi.fn(),
      },
      cashShift: { findFirst: vi.fn() },
      cashOperation: { create: vi.fn(), findMany: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn() },
      expenseCategory: { findFirst: vi.fn() },
      garageBranch: { findFirst: vi.fn() },
      currency: { findFirst: vi.fn() },
      $transaction: vi.fn(),
    },
    audit: { record: vi.fn().mockResolvedValue(undefined) },
    // Мультивалюта: за замовч. базова каса (UAH) → base=amount, rate=1.
    exchangeRates: {
      resolveBaseConversion: vi
        .fn()
        .mockImplementation((_o: string, _c: string, _d: Date, amount: number) =>
          Promise.resolve({ rateUsed: 1, amountBase: amount }),
        ),
    },
  };
}

export type CashMocks = ReturnType<typeof makeMocks>;

export function makeService(m: CashMocks): CashService {
  const s = new CashService(
    m.prisma as unknown as PrismaService,
    m.audit as unknown as AuditService,
    m.exchangeRates as unknown as ExchangeRatesService,
  );
  // $transaction прокидає callback з тим самим prisma-моком (client = prisma).
  m.prisma.$transaction.mockImplementation((fn: (c: unknown) => Promise<unknown>) => fn(m.prisma));
  return s;
}

/**
 * Готовий до операції стан: нефіскальна (за замовч.) каса з залишком `balance`, нульові
 * агрегати, create повертає `opRow()`. Каса віддається на КОЖЕН виклик findFirst
 * (guard каси + getBalance для OUT).
 */
export function setup(opts: { isFiscal?: boolean; balance?: number } = {}) {
  const m = makeMocks();
  const service = makeService(m);
  m.prisma.cashRegister.findFirst.mockResolvedValue({
    id: REG,
    isFiscal: opts.isFiscal ?? false,
    branchId: 'b1',
    currencyId: 'uah-id',
    initialBalance: opts.balance ?? 100000,
  });
  m.prisma.cashOperation.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  m.prisma.cashOperation.create.mockResolvedValue(opRow());
  return { m, service };
}
