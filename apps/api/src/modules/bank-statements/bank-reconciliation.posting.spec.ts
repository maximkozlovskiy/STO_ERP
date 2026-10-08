import { describe, it, expect } from 'vitest';
import { ConflictException } from '@nestjs/common';
import {
  ORG,
  build,
  makeExchange,
  makePayments,
  makePrisma,
} from './bank-reconciliation.spec-fixture';

// Аспект: рознесення рядка в платіж та ігнорування (FSM статусу, matchTransaction / ignoreTransaction / list). Правила BR-BANK — docs/objects/bank-statements.md.
// Кожен кейс доведений мутацією продукт-коду (зламав правило → червоний → відкотив).

describe('BankReconciliationService.matchTransaction — CAS, лінк платежу, валідація рахунку', () => {
  const CP_ID = '22222222-2222-4222-8222-222222222222';
  const TX_ID = '11111111-1111-4111-8111-111111111111';
  const INV_ID = '33333333-3333-4333-8333-333333333333';

  const ROW = {
    id: TX_ID,
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
    status: 'MATCHED',
    matchedType: 'SERVICE',
    counterpartyId: CP_ID,
    paymentId: 'pay-1',
    matchConfidence: null,
    ignoreReason: null,
    createdAt: new Date('2026-09-01'),
  };

  function setup() {
    const prisma = makePrisma();
    prisma.counterparty.findFirst.mockResolvedValue({ id: CP_ID });
    prisma.invoice.findFirst.mockResolvedValue({ id: INV_ID, counterpartyId: CP_ID });
    prisma.bankTransaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.bankTransaction.findFirst.mockResolvedValue({
      id: TX_ID,
      amount: 500,
      bankAccountId: 'ba-7',
    });
    prisma.bankTransaction.findFirstOrThrow.mockResolvedValue(ROW);
    const payments = makePayments();
    payments.create.mockResolvedValue({ id: 'pay-1' });
    return { prisma, payments, service: build(prisma, makeExchange(), payments) };
  }

  // guards: BR-BANK-007
  it('захоплення рядка — CAS: where status=UNMATCHED і paymentId=null; data MATCHED + контрагент + тип', async () => {
    const { prisma, service } = setup();
    await service.matchTransaction(ORG, TX_ID, { counterpartyId: CP_ID, type: 'PREPAYMENT' });
    const cas = prisma.bankTransaction.updateMany.mock.calls[0]![0];
    expect(cas.where).toEqual({
      id: TX_ID,
      orgId: ORG,
      deletedAt: null,
      status: 'UNMATCHED',
      paymentId: null,
    });
    expect(cas.data).toEqual({
      status: 'MATCHED',
      counterpartyId: CP_ID,
      matchedType: 'PREPAYMENT',
    });
  });

  // guards: BR-BANK-007
  it('рядка не існує (або чужа організація) → 404, payments.create НЕ викликаний', async () => {
    const { prisma, payments, service } = setup();
    prisma.bankTransaction.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.bankTransaction.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.matchTransaction(ORG, TX_ID, { counterpartyId: CP_ID, type: 'SERVICE' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(payments.create).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-008
  it('платіж створюється на рахунок рядка, а його id лінкується у paymentId рядка', async () => {
    const { prisma, payments, service } = setup();
    const res = await service.matchTransaction(
      ORG,
      TX_ID,
      { counterpartyId: CP_ID, type: 'SERVICE' },
      'user-1',
    );
    expect(payments.create).toHaveBeenCalledTimes(1);
    const [org, dto, userId] = payments.create.mock.calls[0]!;
    expect(org).toBe(ORG);
    expect(userId).toBe('user-1');
    expect(dto).toMatchObject({
      counterpartyId: CP_ID,
      bankAccountId: 'ba-7',
      sourceType: 'BANK_ACCOUNT',
      amount: 500,
    });
    // SERVICE не прив'язує платіж до рахунку-фактури.
    expect(dto.invoiceId).toBeUndefined();
    const link = prisma.bankTransaction.updateMany.mock.calls.find(
      c => (c[0] as { data: { paymentId?: string } }).data.paymentId !== undefined,
    );
    expect(link).toBeDefined();
    expect(link![0]).toEqual({
      where: { id: TX_ID, orgId: ORG, status: 'MATCHED' },
      data: { paymentId: 'pay-1' },
    });
    expect(res.paymentId).toBe('pay-1');
  });

  // guards: BR-BANK-009
  it('відкат після збою платежу — умовний: лише MATCHED без paymentId → UNMATCHED, контрагент і тип очищено', async () => {
    const { prisma, payments, service } = setup();
    payments.create.mockRejectedValueOnce(new Error('boom'));
    await expect(
      service.matchTransaction(ORG, TX_ID, { counterpartyId: CP_ID, type: 'SERVICE' }),
    ).rejects.toThrow('boom');
    expect(prisma.bankTransaction.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.bankTransaction.updateMany.mock.calls[1]![0]).toEqual({
      where: { id: TX_ID, orgId: ORG, status: 'MATCHED', paymentId: null },
      data: { status: 'UNMATCHED', counterpartyId: null, matchedType: null },
    });
  });

  // guards: BR-BANK-010
  it('INVOICE з рахунком-фактурою поза організацією/видаленим → 404, CAS не чіпається', async () => {
    const { prisma, payments, service } = setup();
    prisma.invoice.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.matchTransaction(ORG, TX_ID, {
        counterpartyId: CP_ID,
        type: 'INVOICE',
        invoiceId: INV_ID,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(payments.create).not.toHaveBeenCalled();
    expect(prisma.bankTransaction.updateMany).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-010, BR-PAY-016
  it('INVOICE з рахунком іншого контрагента → 400 ДО захоплення рядка; платіж не створюється', async () => {
    const { prisma, payments, service } = setup();
    prisma.invoice.findFirst.mockResolvedValueOnce({ id: INV_ID, counterpartyId: 'cp-other' });
    await expect(
      service.matchTransaction(ORG, TX_ID, {
        counterpartyId: CP_ID,
        type: 'INVOICE',
        invoiceId: INV_ID,
      }),
    ).rejects.toThrow('Рахунок виписано на іншого контрагента');
    expect(prisma.bankTransaction.updateMany).not.toHaveBeenCalled();
    expect(payments.create).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-016
  it('tenant: контрагент і рахунок-фактура перевіряються у межах orgId і лише невидалені', async () => {
    const { prisma, service } = setup();
    await service.matchTransaction(ORG, TX_ID, {
      counterpartyId: CP_ID,
      type: 'INVOICE',
      invoiceId: INV_ID,
    });
    expect(prisma.counterparty.findFirst.mock.calls[0]![0].where).toEqual({
      id: CP_ID,
      orgId: ORG,
      deletedAt: null,
    });
    expect(prisma.invoice.findFirst.mock.calls[0]![0].where).toEqual({
      id: INV_ID,
      orgId: ORG,
      deletedAt: null,
    });
  });
});

describe('BankReconciliationService.ignoreTransaction', () => {
  const TX_ID = '11111111-1111-4111-8111-111111111111';

  function setup() {
    const prisma = makePrisma();
    prisma.bankTransaction.updateMany.mockResolvedValue({ count: 1 });
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
      status: 'IGNORED',
      matchedType: null,
      counterpartyId: null,
      paymentId: null,
      matchConfidence: null,
      ignoreReason: 'помилковий переказ',
      createdAt: new Date('2026-09-01'),
    });
    const payments = makePayments();
    return { prisma, payments, service: build(prisma, makeExchange(), payments) };
  }

  // guards: BR-BANK-007
  it('UNMATCHED → IGNORED з причиною через CAS (where status=UNMATCHED, paymentId=null); Payment НЕ створюється', async () => {
    const { prisma, payments, service } = setup();
    const res = await service.ignoreTransaction(ORG, TX_ID, { reason: 'помилковий переказ' });
    expect(prisma.bankTransaction.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.bankTransaction.updateMany.mock.calls[0]![0]).toEqual({
      where: { id: TX_ID, orgId: ORG, deletedAt: null, status: 'UNMATCHED', paymentId: null },
      data: { status: 'IGNORED', ignoreReason: 'помилковий переказ' },
    });
    expect(payments.create).not.toHaveBeenCalled();
    expect(res.status).toBe('IGNORED');
    expect(res.ignoreReason).toBe('помилковий переказ');
  });

  // guards: BR-BANK-007
  it('рядок уже рознесений або проігнорований (CAS count 0, рядок існує) → 409', async () => {
    const { prisma, service } = setup();
    prisma.bankTransaction.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.bankTransaction.findFirst.mockResolvedValueOnce({ id: TX_ID });
    await expect(service.ignoreTransaction(ORG, TX_ID, { reason: 'x' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.bankTransaction.findFirstOrThrow).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-007
  it('рядка не існує (або чужа організація) → 404', async () => {
    const { prisma, service } = setup();
    prisma.bankTransaction.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.bankTransaction.findFirst.mockResolvedValueOnce(null);
    await expect(service.ignoreTransaction(ORG, TX_ID, { reason: 'x' })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('BankReconciliationService.list — tenant-фільтр', () => {
  // guards: BR-BANK-016
  it('list: вибірка і лічильник фільтруються по orgId і deletedAt=null (+ статус із запиту)', async () => {
    const prisma = makePrisma();
    prisma.bankTransaction.findMany.mockResolvedValue([]);
    prisma.bankTransaction.count.mockResolvedValue(0);
    const service = build(prisma, makeExchange(), makePayments());
    await service.list(ORG, { status: 'UNMATCHED' });
    const where = { orgId: ORG, deletedAt: null, status: 'UNMATCHED' };
    expect(prisma.bankTransaction.findMany.mock.calls[0]![0].where).toEqual(where);
    expect(prisma.bankTransaction.count.mock.calls[0]![0].where).toEqual(where);
  });
});
