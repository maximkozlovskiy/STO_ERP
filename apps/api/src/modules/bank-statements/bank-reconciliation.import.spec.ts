import { vi, describe, it, expect } from 'vitest';
import {
  ORG,
  build,
  makeExchange,
  makePayments,
  makePrisma,
} from './bank-reconciliation.spec-fixture';

// Аспект: імпорт виписки у staging (applyImport / previewImport). Правила BR-BANK — docs/objects/bank-statements.md.
// Кожен кейс доведений мутацією продукт-коду (зламав правило → червоний → відкотив).

describe('BankReconciliationService.applyImport — ідемпотентність запису і нормалізація IBAN', () => {
  async function setupApply() {
    const prisma = makePrisma();
    prisma.bankAccount.findFirst.mockResolvedValue({ id: 'ba-1', currencyId: 'cur-1' });
    const createMany = vi
      .fn()
      .mockImplementation((args: { data: unknown[] }) => ({ count: args.data.length }));
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({ bankTransaction: { createMany } }),
    );
    const payments = makePayments();
    const service = await build(prisma, makeExchange(), payments);
    return { prisma, createMany, payments, service };
  }

  // guards: BR-BANK-002
  it('createMany викликається зі skipDuplicates: true — повторний імпорт не дублює рядок', async () => {
    const { createMany, service } = await setupApply();
    await service.applyImport(ORG, {
      bankAccountId: 'ba-1',
      rows: [{ externalId: 'e1', operationDate: '2026-09-01', amount: 100 }],
    });
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0]![0].skipDuplicates).toBe(true);
  });

  // guards: BR-BANK-001
  it('імпорт лише кладе рядки у staging: Payment НЕ створюється', async () => {
    const { payments, service } = await setupApply();
    await service.applyImport(ORG, {
      bankAccountId: 'ba-1',
      rows: [{ externalId: 'e1', operationDate: '2026-09-01', amount: 100 }],
    });
    expect(payments.create).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-006
  it('payerIban зберігається нормалізованим (UPPERCASE, без пробілів); порожній → null', async () => {
    const { createMany, service } = await setupApply();
    await service.applyImport(ORG, {
      bankAccountId: 'ba-1',
      rows: [
        { externalId: 'e1', operationDate: '2026-09-01', amount: 100, payerIban: ' ua12 3456 78 ' },
        { externalId: 'e2', operationDate: '2026-09-01', amount: 100, payerIban: '   ' },
      ],
    });
    const data = createMany.mock.calls[0]![0].data as Array<{ payerIban: string | null }>;
    expect(data[0]!.payerIban).toBe('UA12345678');
    expect(data[1]!.payerIban).toBeNull();
  });
});

describe('BankReconciliationService.previewImport — межі дедуп-перевірки', () => {
  // guards: BR-BANK-002
  it('наявні externalId шукаються лише у своєму рахунку своєї організації', async () => {
    const prisma = makePrisma();
    prisma.counterparty.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.workOrder.findMany.mockResolvedValue([]);
    prisma.bankTransaction.findMany.mockResolvedValue([]);
    const service = await build(prisma, makeExchange(), makePayments());
    await service.previewImport(ORG, 'ba-1', [
      { externalId: 'e1', operationDate: new Date(), amount: 100 },
      { externalId: 'e2', operationDate: new Date(), amount: 200 },
    ]);
    // Прев'ю тепер робить ще й пошук ручних дублів (BR-BANK-037) — беремо саме запит дедупу
    // за externalId, а не «перший findMany».
    const dedup = prisma.bankTransaction.findMany.mock.calls
      .map(c => (c[0] as { where: Record<string, unknown> }).where)
      .find(where => where.externalId !== undefined);
    expect(dedup).toMatchObject({
      orgId: ORG,
      bankAccountId: 'ba-1',
      externalId: { in: ['e1', 'e2'] },
    });
  });
});

describe('BankReconciliationService.applyImport — tenant-фільтр', () => {
  // guards: BR-BANK-016
  it('applyImport: банківський рахунок шукається у своїй orgId і лише невидалений', async () => {
    const prisma = makePrisma();
    prisma.bankAccount.findFirst.mockResolvedValue(null);
    const service = await build(prisma, makeExchange(), makePayments());
    await expect(
      service.applyImport(ORG, { bankAccountId: 'ba-x', rows: [] }),
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.bankAccount.findFirst.mock.calls[0]![0].where).toEqual({
      id: 'ba-x',
      orgId: ORG,
      deletedAt: null,
    });
  });
});
