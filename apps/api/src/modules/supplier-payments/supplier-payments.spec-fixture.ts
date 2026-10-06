/**
 * Спільний harness для спеків SupplierPaymentsService.
 *
 * НАВІЩО. `supplier-payments.service.spec.ts` був 1410 рядків, з них 1235 — ОДИН
 * top-level describe із 56 тестами і ЖОДНОГО вкладеного describe: секції розмічені
 * лише ASCII-швами автора. Усі ділили один ~45-рядковий beforeEach із десятьма
 * prisma-моделями, тож механічне розбиття дало б ~100 рядків дублю на файл.
 *
 * ПЕРЕНЕСЕНО КОПІЮВАННЯМ з оригіналу, не переписуванням. Урок invoices: там я написав
 * exchangeRatesMock «з пам'яті» і втратив `sameCurrency` зі self-referencing closure —
 * 8 тестів упало з «sameCurrency is not a function».
 *
 * ЧОМУ FACTORY. `vitest.config.ts` має `isolate: false` без `clearMocks`: module-level
 * `const` зі спільним `vi.fn()` жив би спільно для всіх спеків воркера.
 *
 * DI-DRIFT GUARD: нова залежність у конструкторі валить усі спеки модуля одразу —
 * і правиться в ОДНОМУ місці, тут.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { Test } from '@nestjs/testing';
import { SupplierPaymentStatus, PaymentSourceType } from '@prisma/client';
import { vi } from 'vitest';
import { SupplierPaymentsService } from './supplier-payments.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { CashService } from '../cash/cash.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';

export const ORG = '00000000-0000-4000-8000-000000000001';
export const SP_ID = '11111111-1111-4111-8111-111111111111';
export const SUPPLIER_ID = '22222222-2222-4222-8222-222222222222';
export const BANK_ID = '33333333-3333-4333-8333-333333333333';
export const CASH_ID = '44444444-4444-4444-8444-444444444444';
export const USER_ID = '77777777-7777-4777-8777-777777777777';

export const confirmedRow = {
  id: SP_ID,
  orgId: ORG,
  number: 'ОПП-20260703-000001',
  status: SupplierPaymentStatus.CONFIRMED,
  supplierId: SUPPLIER_ID,
  sourceType: PaymentSourceType.CASH_REGISTER,
  bankAccountId: null,
  cashRegisterId: CASH_ID,
  purchaseOrderId: null,
  amount: 500,
  method: 'cash',
  notes: null,
  documentDate: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  supplier: { firstName: null, lastName: null, companyName: 'Acme' },
  bankAccount: null,
  cashRegister: { name: 'Каса 1' },
  purchaseOrder: null,
};

// Мультивалюта (Фаза 3): SupplierPaymentsService набув ExchangeRatesService (confirm base-конвертація).
// Default мок — базова валюта (rate=1, amountBase=amount). DI-drift guard (Bug #724 клас).
export const exchangeRatesProvider = () => {
  const useValue = {
    resolveBaseConversion: vi
      .fn()
      // Promise.resolve, а не `async`: у *.spec.ts eslint це пропускає, а у звичайному
      // .ts `require-await` — error. Третя фікстура з тією ж пасткою.
      .mockImplementation((_o: string, _c: string, _d: Date, amount: number) =>
        Promise.resolve({ rateUsed: 1, amountBase: amount }),
      ),
    getBaseCurrency: vi.fn().mockResolvedValue({ id: null, code: 'UAH' }),
    requireBaseCurrencyId: vi.fn().mockResolvedValue('base-cur-id'),
    // Реальна логіка поверх мокнутого getBaseCurrency (тести FX перевизначають getBaseCurrency).
    sameCurrency: vi.fn(async (org: string, a: string | null, b: string | null) => {
      if (a === b) return true;
      const baseId = (await useValue.getBaseCurrency(org)).id;
      const norm = (v: string | null) => v ?? baseId;
      return norm(a) === norm(b);
    }),
  };
  return { provide: ExchangeRatesService, useValue };
};

export async function makeSpHarness() {
  const prisma: Record<string, any> = {
    supplierPayment: {
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }), // CAS confirm: default success
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    counterparty: { findFirst: vi.fn() },
    counterpartyContract: { findMany: vi.fn().mockResolvedValue([]) },
    bankAccount: { findFirst: vi.fn() },
    cashRegister: { findFirst: vi.fn() },
    purchaseOrder: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    settlementAccount: { findMany: vi.fn().mockResolvedValue([]) },
    // Payables FX (Фаза 5): default — chargeBase===paidBase===0 (fx=0 → без FX), count=0.
    settlementTransaction: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amountBase: 0 } }),
      count: vi.fn().mockResolvedValue(0),
    },
    $transaction: vi.fn().mockImplementation((arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
      if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
      return Promise.resolve(arg);
    }),
  };
  const settlements = { createTransaction: vi.fn().mockResolvedValue(undefined) };
  const docNumbers = { next: vi.fn().mockResolvedValue('ОПП-20260703-000001') };
  const cash = { createOperation: vi.fn().mockResolvedValue(undefined) };

  const exchangeRatesRef = exchangeRatesProvider();
  const module = await Test.createTestingModule({
    providers: [
      SupplierPaymentsService,
      { provide: PrismaService, useValue: prisma },
      { provide: SettlementsService, useValue: settlements },
      { provide: DocumentNumberService, useValue: docNumbers },
      { provide: CashService, useValue: cash },
      exchangeRatesRef,
    ],
  }).compile();
  return {
    service: module.get(SupplierPaymentsService),
    prisma,
    settlements,
    docNumbers,
    cash,
    exchangeRates: exchangeRatesRef.useValue,
  };
}

export type SpHarness = Awaited<ReturnType<typeof makeSpHarness>>;
