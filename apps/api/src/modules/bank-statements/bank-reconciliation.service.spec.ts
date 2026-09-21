import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { BankReconciliationService, type RawTx } from './bank-reconciliation.service';
import { toBankTransactionResponseDto } from './bank-statement.dto';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import type { PaymentsService } from '../payments/payments.service';

const ORG = 'org-1';

// ── Мок-фабрики ─────────────────────────────────────────────────────────────────
function makePrisma() {
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
    },
    bankAccount: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  };
}

function makeExchange() {
  return {
    resolveBaseConversion: vi
      .fn()
      .mockImplementation(async (_o: string, _c: string, _d: Date, amount: number) => ({
        rateUsed: 1,
        amountBase: amount,
      })),
  };
}

function makePayments() {
  return { create: vi.fn() };
}

function build(
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

const CP = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  companyName: `Company ${id}`,
  firstName: null,
  lastName: null,
  iban: null,
  edrpou: null,
  ...extra,
});

describe('BankReconciliationService.resolveBatch', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: BankReconciliationService;

  beforeEach(() => {
    prisma = makePrisma();
    prisma.counterparty.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.workOrder.findMany.mockResolvedValue([]);
    service = build(prisma, makeExchange(), makePayments());
  });

  it('IBAN exact-1 → matched confidence 1.0 reason iban', async () => {
    prisma.counterparty.findMany.mockResolvedValueOnce([CP('cp-1', { iban: 'UA123456789' })]);
    const txs: RawTx[] = [
      { externalId: 'e1', operationDate: new Date(), amount: 100, payerIban: 'ua12 3456 789' },
    ];
    const res = await service.resolveBatch(ORG, txs);
    const m = res.get('e1')!;
    expect(m.status).toBe('matched');
    expect(m.counterpartyId).toBe('cp-1');
    expect(m.confidence).toBe(1);
    expect(m.reason).toBe('iban');
  });

  it('IBAN >1 → ambiguous з кандидатами', async () => {
    prisma.counterparty.findMany.mockResolvedValueOnce([
      CP('cp-1', { iban: 'UA999' }),
      CP('cp-2', { iban: 'UA999' }),
    ]);
    const txs: RawTx[] = [
      { externalId: 'e1', operationDate: new Date(), amount: 100, payerIban: 'UA999' },
    ];
    const res = await service.resolveBatch(ORG, txs);
    const m = res.get('e1')!;
    expect(m.status).toBe('ambiguous');
    expect(m.candidates).toHaveLength(2);
  });

  it('EDRPOU exact-1 → matched confidence 0.9 reason edrpou', async () => {
    // Транзакція без IBAN → iban-findMany взагалі не викликається (service гейтить по uniqueIbans).
    // Єдиний counterparty.findMany — edrpou lookup.
    prisma.counterparty.findMany.mockResolvedValueOnce([CP('cp-9', { edrpou: '12345678' })]); // edrpou lookup
    const txs: RawTx[] = [
      { externalId: 'e1', operationDate: new Date(), amount: 100, payerEdrpou: '12345678' },
    ];
    const res = await service.resolveBatch(ORG, txs);
    const m = res.get('e1')!;
    expect(m.status).toBe('matched');
    expect(m.counterpartyId).toBe('cp-9');
    expect(m.confidence).toBe(0.9);
    expect(m.reason).toBe('edrpou');
  });

  it('purpose → INVOICE match confidence 0.7 reason purpose', async () => {
    prisma.invoice.findMany.mockResolvedValueOnce([
      {
        id: 'inv-1',
        number: '777',
        counterpartyId: 'cp-inv',
        counterparty: { companyName: 'Acme', firstName: null, lastName: null },
      },
    ]);
    const txs: RawTx[] = [
      { externalId: 'e1', operationDate: new Date(), amount: 100, purpose: 'Оплата рахунок №777' },
    ];
    const res = await service.resolveBatch(ORG, txs);
    const m = res.get('e1')!;
    expect(m.status).toBe('matched');
    expect(m.matchType).toBe('INVOICE');
    expect(m.invoiceId).toBe('inv-1');
    expect(m.counterpartyId).toBe('cp-inv');
    expect(m.confidence).toBe(0.7);
    expect(m.reason).toBe('purpose');
  });

  it('нічого не збіглось → notFound', async () => {
    const txs: RawTx[] = [
      { externalId: 'e1', operationDate: new Date(), amount: 100, purpose: 'просто переказ' },
    ];
    const res = await service.resolveBatch(ORG, txs);
    expect(res.get('e1')!.status).toBe('notFound');
  });

  it('N+1 guard: findMany викликано ≤ 4 разів на батч будь-якого розміру', async () => {
    // Батч зі 100 транзакцій з різними iban/edrpou/purpose — усе одно кілька bulk-запитів.
    const txs: RawTx[] = Array.from({ length: 100 }, (_, i) => ({
      externalId: `e${i}`,
      operationDate: new Date(),
      amount: 100 + i,
      payerIban: `UA${i}`,
      payerEdrpou: `ED${i}`,
      purpose: `рахунок №${i}`,
    }));
    await service.resolveBatch(ORG, txs);
    const findManyCalls =
      prisma.counterparty.findMany.mock.calls.length +
      prisma.invoice.findMany.mock.calls.length +
      prisma.workOrder.findMany.mock.calls.length;
    // iban(1) + edrpou(1) + invoice(1) + workOrder(1) = 4 максимум.
    expect(findManyCalls).toBeLessThanOrEqual(4);
  });
});

describe('BankReconciliationService.applyImport — дедуп', () => {
  it('createMany зі skipDuplicates; skipped = rows - created', async () => {
    const prisma = makePrisma();
    prisma.bankAccount.findFirst.mockResolvedValue({ id: 'ba-1', currencyId: 'cur-1' });
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        bankTransaction: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
      }),
    );
    const service = build(prisma, makeExchange(), makePayments());
    const res = await service.applyImport(ORG, {
      bankAccountId: 'ba-1',
      rows: [
        { externalId: 'e1', operationDate: '2026-09-01', amount: 100 },
        { externalId: 'e2', operationDate: '2026-09-01', amount: 200 },
        { externalId: 'e1', operationDate: '2026-09-01', amount: 100 }, // дубль → skip
      ],
    });
    expect(res.created).toBe(2);
    expect(res.skipped).toBe(1);
  });
});

describe('BankReconciliationService.matchTransaction', () => {
  const CP_ID = '22222222-2222-4222-8222-222222222222';
  const TX_ID = '11111111-1111-4111-8111-111111111111';

  function setupMatch() {
    const prisma = makePrisma();
    prisma.counterparty.findFirst.mockResolvedValue({ id: CP_ID });
    // CAS-mark успішний.
    prisma.bankTransaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.bankTransaction.findFirst.mockResolvedValue({
      id: TX_ID,
      amount: 500,
      bankAccountId: 'ba-1',
    });
    prisma.bankTransaction.findFirstOrThrow.mockResolvedValue({
      id: TX_ID,
      orgId: ORG,
      bankAccountId: 'ba-1',
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
      status: 'MATCHED',
      matchedType: 'SERVICE',
      counterpartyId: CP_ID,
      paymentId: 'pay-1',
      matchConfidence: null,
      ignoreReason: null,
      createdAt: new Date('2026-09-01'),
    });
    const payments = makePayments();
    payments.create.mockResolvedValue({ id: 'pay-1' });
    const service = build(prisma, makeExchange(), payments);
    return { prisma, payments, service };
  }

  it('SERVICE → settlementType PAYMENT у payments.create', async () => {
    const { payments, service } = setupMatch();
    await service.matchTransaction(ORG, TX_ID, { counterpartyId: CP_ID, type: 'SERVICE' });
    expect(payments.create).toHaveBeenCalledTimes(1);
    const [, dto] = payments.create.mock.calls[0]!;
    expect(dto.settlementType).toBe('PAYMENT');
    expect(dto.method).toBe('bank');
    expect(dto.sourceType).toBe('BANK_ACCOUNT');
  });

  it('PREPAYMENT → settlementType PREPAYMENT', async () => {
    const { payments, service } = setupMatch();
    await service.matchTransaction(ORG, TX_ID, { counterpartyId: CP_ID, type: 'PREPAYMENT' });
    const [, dto] = payments.create.mock.calls[0]!;
    expect(dto.settlementType).toBe('PREPAYMENT');
  });

  it('REFUND → settlementType REFUND', async () => {
    const { payments, service } = setupMatch();
    await service.matchTransaction(ORG, TX_ID, { counterpartyId: CP_ID, type: 'REFUND' });
    const [, dto] = payments.create.mock.calls[0]!;
    expect(dto.settlementType).toBe('REFUND');
  });

  it('подвійний match → CAS count 0 → Conflict', async () => {
    const { prisma, payments, service } = setupMatch();
    prisma.bankTransaction.updateMany.mockResolvedValueOnce({ count: 0 }); // CAS не захопив
    prisma.bankTransaction.findFirst.mockResolvedValueOnce({ id: TX_ID }); // існує, але вже MATCHED
    await expect(
      service.matchTransaction(ORG, TX_ID, { counterpartyId: CP_ID, type: 'SERVICE' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(payments.create).not.toHaveBeenCalled();
  });

  it('payments.create кинув → відкат status=UNMATCHED, помилка проброшена', async () => {
    const { prisma, payments, service } = setupMatch();
    payments.create.mockRejectedValueOnce(new Error('currency mismatch'));
    await expect(
      service.matchTransaction(ORG, TX_ID, { counterpartyId: CP_ID, type: 'SERVICE' }),
    ).rejects.toThrow('currency mismatch');
    // Відкат: другий updateMany з data status=UNMATCHED.
    const rollbackCall = prisma.bankTransaction.updateMany.mock.calls.find(
      c => (c[0] as { data?: { status?: string } }).data?.status === 'UNMATCHED',
    );
    expect(rollbackCall).toBeDefined();
  });

  it('INVOICE → settlementType PAYMENT + invoiceId переданий у payments.create; сума=amount tx', async () => {
    const INV_ID = '33333333-3333-4333-8333-333333333333';
    const { prisma, payments, service } = setupMatch();
    prisma.invoice.findFirst.mockResolvedValue({ id: INV_ID }); // валідація рахунку у межах org
    await service.matchTransaction(ORG, TX_ID, {
      counterpartyId: CP_ID,
      type: 'INVOICE',
      invoiceId: INV_ID,
    });
    const [, dto] = payments.create.mock.calls[0]!;
    // INVOICE — це звичайна оплата рахунку → settlement PAYMENT (не PREPAYMENT/REFUND).
    expect(dto.settlementType).toBe('PAYMENT');
    expect(dto.invoiceId).toBe(INV_ID);
    // Сума платежу = сума захопленої транзакції (500 з setupMatch), НЕ довільна з DTO.
    expect(dto.amount).toBe(500);
  });

  it('INVOICE без invoiceId → BadRequest, payments.create НЕ викликаний, CAS не чіпається', async () => {
    const { prisma, payments, service } = setupMatch();
    await expect(
      service.matchTransaction(ORG, TX_ID, { counterpartyId: CP_ID, type: 'INVOICE' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(payments.create).not.toHaveBeenCalled();
    expect(prisma.bankTransaction.updateMany).not.toHaveBeenCalled();
  });

  it('невалідний контрагент (не в org) → NotFound, CAS не чіпається', async () => {
    const { prisma, payments, service } = setupMatch();
    prisma.counterparty.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.matchTransaction(ORG, TX_ID, { counterpartyId: CP_ID, type: 'SERVICE' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(payments.create).not.toHaveBeenCalled();
    expect(prisma.bankTransaction.updateMany).not.toHaveBeenCalled();
  });
});

describe('BankReconciliationService.previewImport — дедуп по externalId', () => {
  it('уже імпортований externalId → matchStatus=duplicate (перекриває авто-матч)', async () => {
    const prisma = makePrisma();
    prisma.counterparty.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.workOrder.findMany.mockResolvedValue([]);
    // e1 вже існує у цьому рахунку → duplicate; e2 — новий → notFound.
    prisma.bankTransaction.findMany.mockResolvedValue([{ externalId: 'e1' }]);
    const service = build(prisma, makeExchange(), makePayments());
    const rows: RawTx[] = [
      { externalId: 'e1', operationDate: new Date(), amount: 100 },
      { externalId: 'e2', operationDate: new Date(), amount: 200 },
    ];
    const res = await service.previewImport(ORG, 'ba-1', rows);
    expect(res.find(r => r.externalId === 'e1')!.matchStatus).toBe('duplicate');
    expect(res.find(r => r.externalId === 'e2')!.matchStatus).toBe('notFound');
  });
});

describe('BankReconciliationService.applyImport — amountBase + невалідний рахунок', () => {
  it('невідомий bankAccountId → NotFound (до транзакції)', async () => {
    const prisma = makePrisma();
    prisma.bankAccount.findFirst.mockResolvedValue(null);
    const service = build(prisma, makeExchange(), makePayments());
    await expect(
      service.applyImport(ORG, {
        bankAccountId: 'ba-x',
        rows: [{ externalId: 'e1', operationDate: '2026-09-01', amount: 100 }],
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('amountBase рахується через resolveBaseConversion по валюті рахунку', async () => {
    const prisma = makePrisma();
    prisma.bankAccount.findFirst.mockResolvedValue({ id: 'ba-1', currencyId: 'usd' });
    const exchange = makeExchange();
    // USD-рахунок: конвертація 100 USD → 4000 base (rate 40).
    exchange.resolveBaseConversion.mockResolvedValue({ rateUsed: 40, amountBase: 4000 });
    let capturedData: Array<Record<string, unknown>> = [];
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        bankTransaction: {
          createMany: vi
            .fn()
            .mockImplementation((args: { data: Array<Record<string, unknown>> }) => {
              capturedData = args.data;
              return { count: args.data.length };
            }),
        },
      }),
    );
    const service = build(prisma, exchange, makePayments());
    await service.applyImport(ORG, {
      bankAccountId: 'ba-1',
      rows: [{ externalId: 'e1', operationDate: '2026-09-01', amount: 100 }],
    });
    expect(capturedData[0]!.amountBase).toBe(4000);
    expect(capturedData[0]!.rateUsed).toBe(40);
    expect(capturedData[0]!.currencyId).toBe('usd');
    expect(capturedData[0]!.direction).toBe('IN');
    expect(capturedData[0]!.status).toBe('UNMATCHED');
    expect(capturedData[0]!.source).toBe('FILE_IMPORT');
  });
});

// Регресія-guard валютного фіксу (e4fc5e7c): list() робить include bankAccount.currency.code,
// mapper повинен пробросити bankAccountCurrencyCode → UI показує валюту рахунку (multi-bank
// USD/EUR), а не хардкод «₴». amount/currencyId (money-invariant) лишаються у валюті рахунку.
describe('toBankTransactionResponseDto — bankAccountCurrencyCode (multi-bank)', () => {
  const baseRow = () =>
    ({
      id: 't1',
      orgId: ORG,
      bankAccountId: 'ba-1',
      direction: 'IN',
      amount: 150 as unknown as import('@prisma/client').Prisma.Decimal,
      currencyId: 'cur-usd',
      amountBase: 6000 as unknown as import('@prisma/client').Prisma.Decimal,
      rateUsed: 40 as unknown as import('@prisma/client').Prisma.Decimal,
      operationDate: new Date('2026-09-01T00:00:00.000Z'),
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
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    }) as Parameters<typeof toBankTransactionResponseDto>[0];

  it('USD-рахунок → bankAccountCurrencyCode="USD", amount у валюті рахунку (не конвертується)', () => {
    const dto = toBankTransactionResponseDto({
      ...baseRow(),
      bankAccount: { name: 'Mono USD', ibanUA: 'UA00', currency: { code: 'USD' } },
    });
    expect(dto.bankAccountCurrencyCode).toBe('USD');
    // Money-invariant: amount лишається у валюті рахунку, amountBase — окремо у base.
    expect(dto.amount).toBe(150);
    expect(dto.amountBase).toBe(6000);
  });

  it('UAH-рахунок → bankAccountCurrencyCode="UAH"', () => {
    const dto = toBankTransactionResponseDto({
      ...baseRow(),
      bankAccount: { name: 'Privat UAH', ibanUA: 'UA11', currency: { code: 'UAH' } },
    });
    expect(dto.bankAccountCurrencyCode).toBe('UAH');
  });

  it('include без currency (або без bankAccount) → bankAccountCurrencyCode=null', () => {
    expect(
      toBankTransactionResponseDto({
        ...baseRow(),
        bankAccount: { name: 'X', ibanUA: 'UA22', currency: null },
      }).bankAccountCurrencyCode,
    ).toBeNull();
    expect(toBankTransactionResponseDto(baseRow()).bankAccountCurrencyCode).toBeNull();
  });
});
