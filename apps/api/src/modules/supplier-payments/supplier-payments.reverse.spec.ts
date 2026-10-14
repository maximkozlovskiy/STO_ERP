/**
 * Сторно проведеної оплати постачальнику з каси (BR-CASH-024) — що відкочує
 * `SupplierPaymentsService.reverse`:
 *
 *   • статус «Проведено» → «Сторновано» (REVERSED) умовним записом (CAS); інший статус → 400;
 *   • проводка `SUPPLIER_PAYMENT_CANCEL` (−1) на ту саму суму з курсом оригіналу;
 *   • «сплачено» замовлення мінус сума (не нижче 0); `paidAt` знімається, коли замовлення вже не
 *     сплачене повністю, і лишається, коли сплачене;
 *   • оплата не в базовій валюті → 400.
 *
 * Метод внутрішній: кличе його каса зі СВОЄЮ транзакцією, тож кореневий prisma тут на запис
 * заборонений. Довідники — таблиці в пам'яті (`memoryTable`).
 *
 * Написано зі специфікації ДО коду. Контракт (план 2026-10-14):
 *   SupplierPaymentsService.reverse(orgId, id, { cashOperationId, reason, userId }, tx)
 *   проводка: documentType 'SupplierPayment', documentId = id оплати, conversion — з проводки оригіналу.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { SupplierPaymentsService } from './supplier-payments.service';
import { exchangeRatesProvider } from './supplier-payments.spec-fixture';
import { memoryTable, type MemRow } from '../cash/cash.spec-fixture';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SettlementsService } from '../settlements/settlements.service';
import type { DocumentNumberService } from '../document-number/document-number.service';
import type { CashService } from '../cash/cash.service';
import type { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';

const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const SP = '11111111-1111-4111-8111-111111111111';
const SUPPLIER = '22222222-2222-4222-8222-222222222222';
const PO = '55555555-5555-4555-8555-555555555555';
const USER = '77777777-7777-4777-8777-777777777777';
const STORNO_OP = '88888888-8888-4888-8888-888888888888';
const BASE = 'uah-id';

const CTX = { cashOperationId: STORNO_OP, reason: 'оплачено не тому постачальнику', userId: USER };

interface Seed {
  sp?: MemRow;
  po?: MemRow | null;
}

function makeHarness(seed: Seed = {}) {
  const sp: MemRow = {
    id: SP,
    orgId: ORG,
    number: 'ОПП-20261001-000001',
    status: 'CONFIRMED',
    supplierId: SUPPLIER,
    purchaseOrderId: PO,
    sourceType: 'CASH_REGISTER',
    cashRegisterId: 'r0000001-0000-4000-8000-000000000001',
    bankAccountId: null,
    amount: 400,
    currencyId: BASE,
    totalAmountBase: 400,
    rateUsed: 1,
    documentDate: new Date('2026-10-01T00:00:00.000Z'),
    deletedAt: null,
    ...seed.sp,
  };
  const po: MemRow | null =
    seed.po === null
      ? null
      : {
          id: PO,
          orgId: ORG,
          supplierId: SUPPLIER,
          status: 'RECEIVED',
          totalAmount: 1000,
          paidAmount: 1000,
          paidAt: new Date('2026-10-01T00:00:00.000Z'),
          currencyId: null,
          deletedAt: null,
          ...seed.po,
        };

  const tables = {
    supplierPayment: memoryTable([sp]),
    purchaseOrder: memoryTable(po ? [po] : []),
    settlementTransaction: memoryTable([
      {
        id: 'st-orig',
        orgId: ORG,
        settlementAccountId: 'acc-sup',
        type: 'SUPPLIER_PAYMENT',
        amount: sp.amount,
        amountBase: sp.totalAmountBase,
        rateUsed: sp.rateUsed,
        currencyId: sp.currencyId,
        documentType: 'SupplierPayment',
        documentId: SP,
      },
    ]),
  };

  const forbidWrite = (model: string) => () => {
    throw new Error(
      `SupplierPaymentsService.reverse пише через this.prisma.${model} — має йти через tx каси`,
    );
  };
  const root: Record<string, unknown> = {
    $transaction: vi.fn(() => {
      throw new Error(
        'SupplierPaymentsService.reverse не відкриває власної транзакції — працює в tx каси',
      );
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
  const exchangeRates = exchangeRatesProvider().useValue;
  exchangeRates.getBaseCurrency.mockResolvedValue({ id: BASE, code: 'UAH' });
  exchangeRates.requireBaseCurrencyId.mockResolvedValue(BASE);
  const cash = { createOperation: vi.fn() };

  const service = new SupplierPaymentsService(
    root as unknown as PrismaService,
    settlements as unknown as SettlementsService,
    { next: vi.fn() } as unknown as DocumentNumberService,
    cash as unknown as CashService,
    exchangeRates as unknown as ExchangeRatesService,
  );

  const reverse = (orgId = ORG, id = SP) => service.reverse(orgId, id, CTX, tx as never);

  return { service, tables, tx, settlementRows, cash, sp, po, reverse };
}

describe('SupplierPaymentsService.reverse — статус оплати', () => {
  // guards: BR-CASH-024
  it('«Проведено» → «Сторновано» (REVERSED)', async () => {
    const h = makeHarness();
    await h.reverse();
    expect(h.sp.status).toBe('REVERSED');
  });

  // guards: BR-CASH-024
  it.each(['DRAFT', 'CANCELLED', 'REVERSED'])(
    'статус %s → 400, проводки немає, статус не змінено',
    async status => {
      const h = makeHarness({ sp: { status } });
      await expect(h.reverse()).rejects.toThrow(BadRequestException);
      expect(h.sp.status).toBe(status);
      expect(h.settlementRows).toEqual([]);
    },
  );

  // Два сторно разом: обидва прочитали CONFIRMED. Друге зупиняє лише умовний запис
  // (`where status: CONFIRMED`), а не перевірка прочитаного значення.
  // guards: BR-CASH-024
  it('CAS: прочитано «Проведено», а запис уже сторновано паралельно → 400', async () => {
    const h = makeHarness();
    h.sp.status = 'REVERSED';
    const stale = () => Promise.resolve({ ...h.sp, status: 'CONFIRMED' });
    h.tables.supplierPayment.findFirst.mockImplementation(stale);
    h.tables.supplierPayment.findUnique.mockImplementation(stale);
    h.tables.supplierPayment.findFirstOrThrow.mockImplementation(stale);
    h.tables.supplierPayment.findUniqueOrThrow.mockImplementation(stale);
    await expect(h.reverse()).rejects.toThrow(BadRequestException);
  });

  // guards: BR-CASH-024
  it('оплата іншої організації → помилка, статус не змінено', async () => {
    const h = makeHarness();
    await expect(h.reverse(OTHER_ORG)).rejects.toThrow();
    expect(h.sp.status).toBe('CONFIRMED');
    expect(h.settlementRows).toEqual([]);
  });

  // guards: BR-CASH-024
  it('видалена оплата не сторнується', async () => {
    const h = makeHarness({ sp: { deletedAt: new Date('2026-10-02T00:00:00.000Z') } });
    await expect(h.reverse()).rejects.toThrow();
    expect(h.sp.status).toBe('CONFIRMED');
  });

  // Рядок сторно в касі пише каса-диригент; сервіс оплат постачальникам другого не пише.
  // guards: BR-CASH-024, BR-CASH-001
  it('сервіс рядка каси не пише (його вже записала каса)', async () => {
    const h = makeHarness();
    await h.reverse();
    expect(h.cash.createOperation).not.toHaveBeenCalled();
  });
});

describe('SupplierPaymentsService.reverse — проводка', () => {
  // guards: BR-CASH-024
  it('SUPPLIER_PAYMENT_CANCEL на ту саму суму, з постачальником, курсом оригіналу і в tx каси', async () => {
    const h = makeHarness({ sp: { amount: 4200.35, totalAmountBase: 4200.35 } });
    await h.reverse();
    expect(h.settlementRows).toHaveLength(1);
    const posting = h.settlementRows[0];
    expect(posting).toMatchObject({
      orgId: ORG,
      counterpartyId: SUPPLIER,
      // BR-CASH-024: проводка сторно посилається на РЯДОК СТОРНО каси (як повернення, BR-CASH-025);
      // оплату знаходять через нього: reversalOfId → оригінал → documentId.
      type: 'SUPPLIER_PAYMENT_CANCEL',
      documentType: 'CashOperation',
      documentId: STORNO_OP,
    });
    expect(Number(posting.amount)).toBe(4200.35);
    const conversion = posting.conversion as { rateUsed: unknown; amountBase: unknown };
    expect(Number(conversion.rateUsed)).toBe(1);
    expect(Number(conversion.amountBase)).toBe(4200.35);
    expect(posting.__tx).toBe(h.tx);
  });

  // guards: BR-CASH-024
  it('оплата не в базовій валюті → 400, статус і замовлення не змінено', async () => {
    const h = makeHarness({
      sp: { currencyId: 'usd-id', amount: 100, totalAmountBase: 4147, rateUsed: 41.47 },
      po: { currencyId: 'usd-id', totalAmount: 100, paidAmount: 100 },
    });
    await expect(h.reverse()).rejects.toThrow(BadRequestException);
    expect(h.sp.status).toBe('CONFIRMED');
    expect(h.settlementRows).toEqual([]);
  });
});

describe('SupplierPaymentsService.reverse — «сплачено» замовлення', () => {
  // guards: BR-CASH-024
  it('сплачене повністю (1000 з 1000), сторно 400 → 600, paidAt знято', async () => {
    const h = makeHarness();
    await h.reverse();
    expect(Number(h.po?.paidAmount)).toBe(600);
    expect(h.po?.paidAt).toBeNull();
  });

  // Переплата: після сторно замовлення ВСЕ ЩЕ сплачене повністю — дата оплати лишається.
  // guards: BR-CASH-024
  it('переплачене (1500 з 1000), сторно 400 → 1100, paidAt лишається', async () => {
    const paidAt = new Date('2026-09-20T00:00:00.000Z');
    const h = makeHarness({ po: { paidAmount: 1500, paidAt } });
    await h.reverse();
    expect(Number(h.po?.paidAmount)).toBe(1100);
    expect(h.po?.paidAt).toEqual(paidAt);
  });

  // guards: BR-CASH-024
  it('сплачене рівно на суму після сторно (1400 з 1000, сторно 400 → 1000) — paidAt лишається', async () => {
    const paidAt = new Date('2026-09-20T00:00:00.000Z');
    const h = makeHarness({ po: { paidAmount: 1400, paidAt } });
    await h.reverse();
    expect(Number(h.po?.paidAmount)).toBe(1000);
    expect(h.po?.paidAt).toEqual(paidAt);
  });

  // guards: BR-CASH-024
  it('частково сплачене (700), сторно 400 з копійками → 299.99, paidAt як був (null)', async () => {
    const h = makeHarness({
      sp: { amount: 400.01, totalAmountBase: 400.01 },
      po: { paidAmount: 700, paidAt: null },
    });
    await h.reverse();
    expect(Number(h.po?.paidAmount)).toBeCloseTo(299.99, 2);
    expect(h.po?.paidAt).toBeNull();
  });

  // guards: BR-CASH-024
  it('«сплачено» не йде нижче нуля (розійшлось раніше: 250 при оплаті 400) → 0', async () => {
    const h = makeHarness({ po: { paidAmount: 250, paidAt: null } });
    await h.reverse();
    expect(Number(h.po?.paidAmount)).toBe(0);
  });

  // guards: BR-CASH-024
  it('оплата без замовлення: статус і проводка є, замовлень не чіпає', async () => {
    const h = makeHarness({ sp: { purchaseOrderId: null } });
    await h.reverse();
    expect(h.sp.status).toBe('REVERSED');
    expect(h.settlementRows).toHaveLength(1);
    expect(h.po).toMatchObject({ paidAmount: 1000 });
    expect(h.po?.paidAt).not.toBeNull();
  });
});
