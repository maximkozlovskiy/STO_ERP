/**
 * Спільний harness для спеків InvoicesService.
 *
 * НАВІЩО. `invoices.service.spec.ts` був 1244 рядки, з них 1011 — ОДИН top-level
 * describe із 10 вкладеними, усі під СПІЛЬНИМ 85-рядковим `beforeEach`. Дешеве
 * розбиття по top-level дало б 1011 + 95 + 99, тобто моноліт нікуди б не зник.
 * Тому вкладені describe піднімаються у власні файли, а їхній спільний сетап — сюди.
 *
 * ЧОМУ БІЛДЕР ПОВЕРТАЄ ВСІ REF-И, а не лише `service`. Тести асертять і перевизначають
 * моки всередині кейсів: `settings.getDefaultVatRate.mockResolvedValue(...)` у ПДВ-тестах,
 * `exchangeRates.getBaseCurrency` у FX-тестах (Bug #745). Якби білдер віддавав лише
 * сервіс, кожен такий кейс довелося б переписувати — а це вже не «перенесено дослівно».
 *
 * ЧОМУ FACTORY. `apps/api/vitest.config.ts` має `isolate: false` без `clearMocks`, тож
 * module-level `const` зі спільним `vi.fn()` жив би спільно для всіх спеків воркера.
 * Кожен виклик `makeInvoicesHarness()` будує набір моків з нуля — як і вихідний
 * `beforeEach`, поведінка ідентична.
 *
 * DI-DRIFT GUARD (Bug #536, #724). Нова залежність у конструкторі `InvoicesService`
 * валить усі спеки модуля одразу з «Nest can't resolve dependencies». Це очікувано й
 * корисно: падіння видно відразу, а не через місяць — і правиться в ОДНОМУ місці, тут.
 */
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PdfService } from '../pdf/pdf.service';
import { SettlementsService } from '../settlements/settlements.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';

export const ORG = 'org-1';
export const WO_ID = '11111111-1111-4111-8111-111111111111';
export const INV_ID = '22222222-2222-4222-8222-222222222222';

type Fn = ReturnType<typeof vi.fn>;

export interface InvoicesHarness {
  service: InvoicesService;
  prisma: {
    invoice: { findFirst: Fn; create: Fn; update: Fn; updateMany: Fn };
    invoiceLine: { deleteMany: Fn; createMany: Fn };
    workOrder: { findFirst: Fn };
    counterparty: { findFirst: Fn };
    settlementTransaction: { count: Fn; aggregate: Fn };
    payment: { aggregate: Fn };
    $transaction: Fn;
  };
  docNumbers: { next: Fn };
  pdf: { generateInvoicePdf: Fn };
  settlements: { createTransaction: Fn };
  settings: Record<string, Fn>;
  exchangeRates: { resolveBaseConversion: Fn; getBaseCurrency: Fn };
}

/**
 * Дефолтний мок конвертації: базова валюта (rate=1, amountBase=amount).
 * `Promise.resolve`, а не `async`: у звичайному `.ts` eslint `require-await` — error.
 */
export const exchangeRatesMock = () => {
  const useValue = {
    resolveBaseConversion: vi
      .fn()
      .mockImplementation((_o: string, _c: string, _d: Date, amount: number) =>
        Promise.resolve({ rateUsed: 1, amountBase: amount }),
      ),
    getBaseCurrency: vi.fn().mockResolvedValue({ id: null, code: 'UAH' }),
    requireBaseCurrencyId: vi.fn().mockResolvedValue('base-cur-id'),
    // Реальна логіка sameCurrency (Фаза 5 консолідація) поверх мока: читає base У МОМЕНТ
    // виклику через useValue.getBaseCurrency, тож перевизначення getBaseCurrency у
    // FX-тестах (Bug #745) впливає і на неї. Self-referencing closure — обов'язковий:
    // без нього transition() падає з "this.exchangeRates.sameCurrency is not a function".
    sameCurrency: vi.fn(async (org: string, a: string | null, b: string | null) => {
      if (a === b) return true;
      const baseId = ((await useValue.getBaseCurrency(org)) as { id: string | null }).id;
      const norm = (v: string | null) => v ?? baseId;
      return norm(a) === norm(b);
    }),
  };
  return { provide: ExchangeRatesService, useValue };
};

export async function makeInvoicesHarness(): Promise<InvoicesHarness> {
  const prisma: InvoicesHarness['prisma'] = {
    invoice: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    invoiceLine: { deleteMany: vi.fn(), createMany: vi.fn() },
    workOrder: { findFirst: vi.fn() },
    counterparty: { findFirst: vi.fn() },
    // Bug #745: FX-хук у transition() агрегує леджер + Payment для інваріанта.
    settlementTransaction: {
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _sum: { amountBase: 0 } }),
    },
    payment: { aggregate: vi.fn().mockResolvedValue({ _sum: { amountBase: 0 } }) },
    $transaction: vi.fn().mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
      return Promise.resolve(undefined);
    }),
  };
  const docNumbers = { next: vi.fn().mockResolvedValue('INV-2026-0001') };
  const pdf = { generateInvoicePdf: vi.fn() };
  const settlements = { createTransaction: vi.fn() };
  const exchangeRatesProvider = exchangeRatesMock();
  const exchangeRates = exchangeRatesProvider.useValue as InvoicesHarness['exchangeRates'];
  // Дефолт VAT = NONE; тести, що перевіряють ПДВ, перевизначають це у кейсі.
  const settings: Record<string, Fn> = {
    getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }),
    // §13: invoiceDueDays керує дефолтним терміном оплати.
    getOrganisationSettings: vi.fn().mockResolvedValue({ invoiceDueDays: 7 }),
  };

  const module = await Test.createTestingModule({
    providers: [
      InvoicesService,
      { provide: PrismaService, useValue: prisma },
      { provide: DocumentNumberService, useValue: docNumbers },
      { provide: PdfService, useValue: pdf },
      { provide: SettlementsService, useValue: settlements },
      { provide: SettingsService, useValue: settings },
      { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
      exchangeRatesProvider,
    ],
  }).compile();

  return {
    service: module.get(InvoicesService),
    prisma,
    docNumbers,
    pdf,
    settlements,
    settings,
    exchangeRates,
  };
}
