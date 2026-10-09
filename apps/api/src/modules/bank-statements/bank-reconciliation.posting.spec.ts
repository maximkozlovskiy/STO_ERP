import { describe, it, expect } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import {
  ORG,
  build,
  makeExchange,
  makePayments,
  makePrisma,
} from './bank-reconciliation.spec-fixture';
import {
  ID,
  ORG as W_ORG,
  ROW_AMOUNT,
  USER,
  makeWorld,
} from './bank-reconciliation.world.spec-fixture';
import { BANK_TX_IN_MATCH_TYPES } from './bank-statement.dto';

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

  async function setup() {
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
    return { prisma, payments, service: await build(prisma, makeExchange(), payments) };
  }

  // Переписано 2026-10-09: до BR-BANK-025 where був рівно {id, orgId, deletedAt, status, paymentId},
  // а data — рівно три поля. Тепер у where додано напрям, у data — matchedAt / matchedBy
  // (BR-BANK-026), тож звіряємо поля правила, а не повний об'єкт.
  // guards: BR-BANK-007, BR-BANK-025
  it('захоплення рядка — CAS: where status=UNMATCHED, paymentId=null і direction=IN; data MATCHED + контрагент + тип', async () => {
    const { prisma, service } = await setup();
    await service.matchTransaction(ORG, TX_ID, { counterpartyId: CP_ID, type: 'PREPAYMENT' });
    const cas = prisma.bankTransaction.updateMany.mock.calls[0]![0];
    expect(cas.where).toEqual({
      id: TX_ID,
      orgId: ORG,
      deletedAt: null,
      status: 'UNMATCHED',
      paymentId: null,
      direction: 'IN',
    });
    expect(cas.data).toMatchObject({
      status: 'MATCHED',
      counterpartyId: CP_ID,
      matchedType: 'PREPAYMENT',
    });
  });

  // guards: BR-BANK-007
  it('рядка не існує (або чужа організація) → 404, payments.create НЕ викликаний', async () => {
    const { prisma, payments, service } = await setup();
    prisma.bankTransaction.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.bankTransaction.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.matchTransaction(ORG, TX_ID, { counterpartyId: CP_ID, type: 'SERVICE' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(payments.create).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-008
  it('платіж створюється на рахунок рядка, а його id лінкується у paymentId рядка', async () => {
    const { prisma, payments, service } = await setup();
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
    const { prisma, payments, service } = await setup();
    payments.create.mockRejectedValueOnce(new Error('boom'));
    await expect(
      service.matchTransaction(ORG, TX_ID, { counterpartyId: CP_ID, type: 'SERVICE' }),
    ).rejects.toThrow('boom');
    expect(prisma.bankTransaction.updateMany).toHaveBeenCalledTimes(2);
    const rollback = prisma.bankTransaction.updateMany.mock.calls[1]![0];
    // Умова відкату — рівно ця: без `paymentId: null` відкат зняв би статус із рядка, платіж якого
    // вже створено. У data правило вимагає три поля; чи очищати ще й matchedAt / matchedBy — не його справа.
    expect(rollback.where).toEqual({ id: TX_ID, orgId: ORG, status: 'MATCHED', paymentId: null });
    expect(rollback.data).toMatchObject({
      status: 'UNMATCHED',
      counterpartyId: null,
      matchedType: null,
    });
  });

  // guards: BR-BANK-010
  it('INVOICE з рахунком-фактурою поза організацією/видаленим → 404, CAS не чіпається', async () => {
    const { prisma, payments, service } = await setup();
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
    const { prisma, payments, service } = await setup();
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
    const { prisma, service } = await setup();
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

  async function setup() {
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
    return { prisma, payments, service: await build(prisma, makeExchange(), payments) };
  }

  // guards: BR-BANK-007
  it('UNMATCHED → IGNORED з причиною через CAS (where status=UNMATCHED, paymentId=null); Payment НЕ створюється', async () => {
    const { prisma, payments, service } = await setup();
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
    const { prisma, service } = await setup();
    prisma.bankTransaction.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.bankTransaction.findFirst.mockResolvedValueOnce({ id: TX_ID });
    await expect(service.ignoreTransaction(ORG, TX_ID, { reason: 'x' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.bankTransaction.findFirstOrThrow).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-007
  it('рядка не існує (або чужа організація) → 404', async () => {
    const { prisma, service } = await setup();
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
    const service = await build(prisma, makeExchange(), makePayments());
    await service.list(ORG, { status: 'UNMATCHED' });
    const where = { orgId: ORG, deletedAt: null, status: 'UNMATCHED' };
    expect(prisma.bankTransaction.findMany.mock.calls[0]![0].where).toEqual(where);
    expect(prisma.bankTransaction.count.mock.calls[0]![0].where).toEqual(where);
  });

  // Вкладки списку «Вхідні» / «Вихідні» (рішення власника 2026-10-08).
  it.each(['IN', 'OUT'] as const)(
    'list: direction=%s звужує і вибірку, і лічильник; orgId та deletedAt лишаються',
    async direction => {
      const prisma = makePrisma();
      prisma.bankTransaction.findMany.mockResolvedValue([]);
      prisma.bankTransaction.count.mockResolvedValue(0);
      const service = await build(prisma, makeExchange(), makePayments());
      await service.list(ORG, { direction, status: 'MATCHED' });
      const where = { orgId: ORG, deletedAt: null, status: 'MATCHED', direction };
      expect(prisma.bankTransaction.findMany.mock.calls[0]![0].where).toEqual(where);
      expect(prisma.bankTransaction.count.mock.calls[0]![0].where).toEqual(where);
    },
  );

  it('list: без direction умови на напрямок немає — «Всі» показує обидва', async () => {
    const prisma = makePrisma();
    prisma.bankTransaction.findMany.mockResolvedValue([]);
    prisma.bankTransaction.count.mockResolvedValue(0);
    const service = await build(prisma, makeExchange(), makePayments());
    await service.list(ORG, {});
    expect(prisma.bankTransaction.findMany.mock.calls[0]![0].where).toEqual({
      orgId: ORG,
      deletedAt: null,
    });
  });

  // Пошук і відбір за датою (рішення власника 2026-10-09).
  it('list: q → платник, призначення, IBAN (без пробілів) або ЄДРПОУ; tenant лишається зверху', async () => {
    const prisma = makePrisma();
    prisma.bankTransaction.findMany.mockResolvedValue([]);
    prisma.bankTransaction.count.mockResolvedValue(0);
    const service = await build(prisma, makeExchange(), makePayments());

    await service.list(ORG, { q: ' UA21 3223 ' });

    const where = prisma.bankTransaction.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ orgId: ORG, deletedAt: null });
    expect(where.OR).toEqual([
      { payerName: { contains: 'UA21 3223', mode: 'insensitive' } },
      { purpose: { contains: 'UA21 3223', mode: 'insensitive' } },
      { payerIban: { contains: 'UA213223', mode: 'insensitive' } },
      { payerEdrpou: { contains: 'UA21 3223', mode: 'insensitive' } },
    ]);
    expect(prisma.bankTransaction.count.mock.calls[0]![0].where).toEqual(where);
  });

  it('list: q із символами підстановки LIKE (% _) шукається буквально в усіх чотирьох полях', async () => {
    const prisma = makePrisma();
    prisma.bankTransaction.findMany.mockResolvedValue([]);
    prisma.bankTransaction.count.mockResolvedValue(0);
    const service = await build(prisma, makeExchange(), makePayments());

    await service.list(ORG, { q: 'ПДВ 20%_' });

    expect(prisma.bankTransaction.findMany.mock.calls[0]![0].where.OR).toEqual([
      { payerName: { contains: 'ПДВ 20\\%\\_', mode: 'insensitive' } },
      { purpose: { contains: 'ПДВ 20\\%\\_', mode: 'insensitive' } },
      { payerIban: { contains: 'ПДВ20\\%\\_', mode: 'insensitive' } },
      { payerEdrpou: { contains: 'ПДВ 20\\%\\_', mode: 'insensitive' } },
    ]);
  });

  it('list: dateFrom/dateTo → дата операції календарними датами (це @db.Date, без зсуву на пояс)', async () => {
    const prisma = makePrisma();
    prisma.bankTransaction.findMany.mockResolvedValue([]);
    prisma.bankTransaction.count.mockResolvedValue(0);
    const service = await build(prisma, makeExchange(), makePayments());

    await service.list(ORG, { dateFrom: '2026-10-08', dateTo: '2026-10-09', direction: 'IN' });

    expect(prisma.bankTransaction.findMany.mock.calls[0]![0].where).toEqual({
      orgId: ORG,
      deletedAt: null,
      direction: 'IN',
      operationDate: {
        gte: new Date('2026-10-08T00:00:00.000Z'),
        lte: new Date('2026-10-09T00:00:00.000Z'),
      },
    });
  });
});

// Написано ДО реалізації вихідних платежів (2026-10-09), на даних у пам'яті (`makeWorld`).
// Mutation-verify: прибрати `direction: 'IN'` з where CAS у matchTransaction (і перевірку напряму
// перед ним) → обидва кейси «вихідний рядок» червоніють: рядок стає MATCHED, платіж створюється.
describe('BankReconciliationService.matchTransaction — лише вхідний рядок (BR-BANK-025)', () => {
  // guards: BR-BANK-025
  it.each(BANK_TX_IN_MATCH_TYPES)(
    'вихідний рядок, вид %s → 400 «не підходить для напряму», Payment не створюється, рядок лишається UNMATCHED',
    async type => {
      const w = await makeWorld();
      w.addRow({ direction: 'OUT' });
      const invoiceId = w.db.seed('invoice', {
        id: w.db.nextId(),
        orgId: W_ORG,
        number: '777',
        counterpartyId: ID.client,
      }).id as string;

      await expect(
        w.service.matchTransaction(
          W_ORG,
          ID.tx,
          { counterpartyId: ID.client, type, ...(type === 'INVOICE' ? { invoiceId } : {}) },
          USER,
        ),
      ).rejects.toMatchObject({
        status: 400,
        message: translateError('err.bankStatement.wrongDirection', 'uk'),
      });

      expect(w.payments.create).not.toHaveBeenCalled();
      expect(w.row()).toMatchObject({
        status: 'UNMATCHED',
        matchedType: null,
        counterpartyId: null,
        paymentId: null,
      });
    },
  );

  // guards: BR-BANK-025
  it('вхідний рядок на тих самих даних розноситься: MATCHED, один Payment на суму рядка', async () => {
    const w = await makeWorld();
    w.addRow({ direction: 'IN' });

    await w.service.matchTransaction(
      W_ORG,
      ID.tx,
      { counterpartyId: ID.client, type: 'PREPAYMENT' },
      USER,
    );

    expect(w.payments.create).toHaveBeenCalledTimes(1);
    expect(w.payments.create.mock.calls[0]![1]).toMatchObject({
      counterpartyId: ID.client,
      amount: ROW_AMOUNT,
      bankAccountId: ID.account,
    });
    expect(w.row()).toMatchObject({ status: 'MATCHED', matchedType: 'PREPAYMENT' });
  });
});
