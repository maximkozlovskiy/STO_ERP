/**
 * Читання взаєморозрахунків (SettlementsAccountService.getBalance / getTransactions /
 * getReconciliationActs). Правила BR-SETL-006, BR-SETL-013 — docs/objects/settlements.md.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeAccountFixture, txRow } from './settlements.spec-fixture';

describe('SettlementsAccountService — читання балансу і журналу', () => {
  let prisma: ReturnType<typeof makeAccountFixture>['prisma'];
  let service: ReturnType<typeof makeAccountFixture>['service'];

  beforeEach(() => {
    ({ prisma, service } = makeAccountFixture());
  });

  // guards: BR-SETL-013
  it('баланс контрагента без рахунку → 0, а не помилка', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue(null);

    await expect(service.getBalance('org-1', 'cp-1')).resolves.toEqual({
      balance: 0,
      counterpartyId: 'cp-1',
    });
  });

  // guards: BR-SETL-006
  it('баланс читається за організацією і контрагентом і віддається числом', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ balance: '-250.50' });

    const res = await service.getBalance('org-1', 'cp-1');

    expect(prisma.settlementAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: 'org-1', counterpartyId: 'cp-1' } }),
    );
    expect(res).toEqual({ balance: -250.5, counterpartyId: 'cp-1' });
  });

  // guards: BR-SETL-013
  it('журнал контрагента без рахунку → порожня сторінка, транзакції не читаються', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue(null);

    await expect(service.getTransactions('org-1', 'cp-1', 1, 50)).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      limit: 50,
    });
    expect(prisma.settlementTransaction.findMany).not.toHaveBeenCalled();
  });

  // guards: BR-SETL-006, BR-SETL-013
  it('журнал: лише свій рахунок і своя організація, від найновіших', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });

    await service.getTransactions('org-1', 'cp-1', 2, 10);

    expect(prisma.settlementAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: 'org-1', counterpartyId: 'cp-1' } }),
    );
    expect(prisma.settlementTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { settlementAccountId: 'acc-1', orgId: 'org-1' },
        orderBy: { createdAt: 'desc' },
        skip: 10,
        take: 10,
      }),
    );
    expect(prisma.settlementTransaction.count).toHaveBeenCalledWith({
      where: { settlementAccountId: 'acc-1', orgId: 'org-1' },
    });
  });

  // guards: BR-SETL-013
  it('розмір сторінки журналу обрізається до 200', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });

    const res = await service.getTransactions('org-1', 'cp-1', 1, 999_999);

    expect(prisma.settlementTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 200 }),
    );
    expect(res.limit).toBe(200);
  });

  // guards: BR-SETL-013
  it('рядок журналу: сума у валюті транзакції, код валюти, сума у базовій і курс — числами; порожні лишаються null', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    const createdAt = new Date('2026-07-10T09:00:00.000Z');
    prisma.settlementTransaction.findMany.mockResolvedValue([
      txRow({
        id: 'tx-usd',
        type: 'PAYMENT',
        amount: '100.00',
        amountBase: '4150.00',
        rateUsed: '41.5',
        currencyId: 'usd-1',
        currency: { code: 'USD' },
        documentType: 'Payment',
        documentId: 'pay-1',
        notes: 'оплата',
        createdAt,
      }),
      txRow({ id: 'tx-old', amount: '70.00', amountBase: null, rateUsed: null, createdAt }),
    ]);
    prisma.settlementTransaction.count.mockResolvedValue(2);

    const res = await service.getTransactions('org-1', 'cp-1', 1, 50);

    expect(res.total).toBe(2);
    expect(res.items).toEqual([
      {
        id: 'tx-usd',
        type: 'PAYMENT',
        amount: 100,
        currencyId: 'usd-1',
        currencyCode: 'USD',
        amountBase: 4150,
        rateUsed: 41.5,
        documentType: 'Payment',
        documentId: 'pay-1',
        notes: 'оплата',
        createdAt,
      },
      {
        id: 'tx-old',
        type: 'CHARGE',
        amount: 70,
        currencyId: null,
        currencyCode: null,
        amountBase: null,
        rateUsed: null,
        documentType: null,
        documentId: null,
        notes: null,
        createdAt,
      },
    ]);
  });

  // guards: BR-SETL-006
  it('список актів звірки: лише своя організація і цей контрагент, від найновіших', async () => {
    await service.getReconciliationActs('org-1', 'cp-1');

    expect(prisma.reconciliationAct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: 'org-1', counterpartyId: 'cp-1' },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });
});
