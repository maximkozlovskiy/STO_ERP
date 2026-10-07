import { vi } from 'vitest';
import { BankReconciliationService } from './bank-reconciliation.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import type { PaymentsService } from '../payments/payments.service';

// Спільний сетап аспектних спеків BankReconciliationService (`bank-reconciliation.*.spec.ts`).
// Фабрики, не const: кожен тест бере свіжі моки (isolate:false без clearMocks).
// Скопійовано з преамбули `bank-reconciliation.service.spec.ts` (той файл лишився зі своєю).

export const ORG = 'org-1';

export function makePrisma() {
  return {
    counterparty: { findMany: vi.fn(), findFirst: vi.fn() },
    invoice: { findMany: vi.fn(), findFirst: vi.fn() },
    workOrder: { findMany: vi.fn() },
    bankTransaction: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      updateMany: vi.fn(),
      createMany: vi.fn(),
      count: vi.fn(),
    },
    bankAccount: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  };
}

export function makeExchange() {
  return {
    resolveBaseConversion: vi
      .fn()
      .mockImplementation((_o: string, _c: string, _d: Date, amount: number) =>
        Promise.resolve({ rateUsed: 1, amountBase: amount }),
      ),
  };
}

export function makePayments() {
  return { create: vi.fn() };
}

export function build(
  prisma: ReturnType<typeof makePrisma>,
  exchange: ReturnType<typeof makeExchange>,
  payments: ReturnType<typeof makePayments>,
) {
  return new BankReconciliationService(
    prisma as unknown as PrismaService,
    exchange as unknown as ExchangeRatesService,
    payments as unknown as PaymentsService,
  );
}

/** Контрагент-рядок для моків counterparty.findMany. */
export const CP = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  companyName: `Company ${id}`,
  firstName: null,
  lastName: null,
  iban: null,
  edrpou: null,
  ...extra,
});

/** Повний рядок BankTransaction (форма, яку читає toBankTransactionResponseDto). */
export const txRow = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  orgId: ORG,
  bankAccountId: 'ba-7',
  direction: 'IN',
  amount: 500,
  currencyId: 'cur-1',
  amountBase: 500,
  rateUsed: 1,
  operationDate: new Date('2026-09-01'),
  payerName: null,
  payerIban: null,
  payerEdrpou: null,
  purpose: null,
  externalId: 'e1',
  source: 'FILE_IMPORT',
  status: 'UNMATCHED',
  matchedType: null,
  counterpartyId: null,
  paymentId: null,
  matchConfidence: null,
  ignoreReason: null,
  createdAt: new Date('2026-09-01'),
  ...over,
});
