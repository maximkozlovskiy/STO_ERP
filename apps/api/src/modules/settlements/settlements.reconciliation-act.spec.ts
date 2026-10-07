/**
 * Акт звірки (SettlementsAccountService.createReconciliationAct / generateReconciliationPdf).
 * Правила BR-SETL-006, BR-SETL-011, BR-SETL-012 — docs/objects/settlements.md.
 */
import { NotFoundException } from '@nestjs/common';
import { describe, it, expect, beforeEach } from 'vitest';
import { makeAccountFixture, txRow } from './settlements.spec-fixture';

describe('SettlementsAccountService — акт звірки', () => {
  let prisma: ReturnType<typeof makeAccountFixture>['prisma'];
  let pdf: ReturnType<typeof makeAccountFixture>['pdf'];
  let service: ReturnType<typeof makeAccountFixture>['service'];

  const period = { periodFrom: '2026-07-01', periodTo: '2026-07-31' };

  beforeEach(() => {
    ({ prisma, pdf, service } = makeAccountFixture());
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1', balance: '1000.00' });
  });

  // guards: BR-SETL-011
  it('відкриваючий баланс = поточний баланс − Σ знак×сума транзакцій періоду (знак з BALANCE_SIGN)', async () => {
    prisma.settlementTransaction.findMany.mockResolvedValue([
      txRow({ type: 'CHARGE', amount: '300.00', amountBase: '300.00' }), // +300
      txRow({ type: 'PAYMENT', amount: '100.00', amountBase: '100.00' }), // −100
      txRow({ type: 'SUPPLIER_CHARGE', amount: '50.00', amountBase: '50.00' }), // −50
      txRow({ type: 'SUPPLIER_PAYMENT', amount: '20.00', amountBase: '20.00' }), // +20
    ]);

    const act = await service.createReconciliationAct('org-1', 'cp-1', period, 'user-1');

    // Дельта періоду = 300 − 100 − 50 + 20 = 170 → відкриваючий = 1000 − 170.
    expect(prisma.reconciliationAct.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: 'org-1',
        counterpartyId: 'cp-1',
        closingBalance: 1000,
        openingBalance: 830,
        createdBy: 'user-1',
      }),
    });
    expect(act.closingBalance).toBe(1000);
    expect(act.openingBalance).toBe(830);
  });

  // guards: BR-SETL-011
  it('іновалютна транзакція входить у дельту сумою у базовій валюті, історична без amountBase — сумою amount', async () => {
    prisma.settlementTransaction.findMany.mockResolvedValue([
      // 100 USD за курсом 41.50 → 4150 у базовій
      txRow({ type: 'CHARGE', amount: '100.00', amountBase: '4150.00', currencyId: 'usd-1' }),
      // рядок до мультивалюти: amountBase порожній → береться amount
      txRow({ type: 'PAYMENT', amount: '500.00', amountBase: null }),
    ]);

    const act = await service.createReconciliationAct('org-1', 'cp-1', period);

    // Дельта = +4150 − 500 = 3650 → відкриваючий = 1000 − 3650.
    expect(act.openingBalance).toBe(-2650);
  });

  // guards: BR-SETL-011
  it('межі періоду — календарні дні Києва, літній час (UTC+3)', async () => {
    await service.createReconciliationAct('org-1', 'cp-1', period);

    const from = new Date('2026-06-30T21:00:00.000Z');
    const to = new Date('2026-07-31T20:59:59.999Z');
    expect(prisma.settlementTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdAt: { gte: from, lte: to } }),
      }),
    );
    expect(prisma.reconciliationAct.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ periodFrom: from, periodTo: to }),
    });
  });

  // guards: BR-SETL-011
  it('межі періоду — календарні дні Києва, зимовий час (UTC+2)', async () => {
    await service.createReconciliationAct('org-1', 'cp-1', {
      periodFrom: '2026-01-01',
      periodTo: '2026-01-31',
    });

    expect(prisma.settlementTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date('2025-12-31T22:00:00.000Z'),
            lte: new Date('2026-01-31T21:59:59.999Z'),
          },
        }),
      }),
    );
  });

  // guards: BR-SETL-011
  it('знімок рядків зберігається в акті: дата, тип, сума, сума у базовій валюті, валюта, документ', async () => {
    const createdAt = new Date('2026-07-10T09:00:00.000Z');
    prisma.settlementTransaction.findMany.mockResolvedValue([
      txRow({
        type: 'CHARGE',
        amount: '100.00',
        amountBase: '4150.00',
        currencyId: 'usd-1',
        documentType: 'WorkOrder',
        documentId: 'wo-1',
        createdAt,
      }),
      txRow({ type: 'PAYMENT', amount: '500.00', amountBase: null, createdAt }),
    ]);

    const act = await service.createReconciliationAct('org-1', 'cp-1', period);

    expect(act.transactions).toEqual([
      {
        date: createdAt,
        type: 'CHARGE',
        amount: 100,
        amountBase: 4150,
        currencyId: 'usd-1',
        documentType: 'WorkOrder',
        documentId: 'wo-1',
      },
      {
        date: createdAt,
        type: 'PAYMENT',
        amount: 500,
        amountBase: 500,
        currencyId: null,
        documentType: null,
        documentId: null,
      },
    ]);
  });

  // guards: BR-SETL-006
  it('транзакції періоду беруться лише зі свого рахунку і своєї організації, від найстаріших', async () => {
    await service.createReconciliationAct('org-1', 'cp-1', period);

    expect(prisma.settlementAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: 'org-1', counterpartyId: 'cp-1' } }),
    );
    expect(prisma.settlementTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ settlementAccountId: 'acc-1', orgId: 'org-1' }),
        orderBy: { createdAt: 'asc' },
      }),
    );
  });

  // guards: BR-SETL-012
  it('контрагента немає у цій організації (чужий або видалений) → NotFound, акт не створюється', async () => {
    prisma.counterparty.findFirst.mockResolvedValue(null);

    await expect(service.createReconciliationAct('org-1', 'cp-1', period)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.counterparty.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cp-1', orgId: 'org-1', deletedAt: null } }),
    );
    expect(prisma.reconciliationAct.create).not.toHaveBeenCalled();
  });

  // guards: BR-SETL-012
  it('у контрагента немає рахунку → NotFound, акт не створюється', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue(null);

    await expect(service.createReconciliationAct('org-1', 'cp-1', period)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.reconciliationAct.create).not.toHaveBeenCalled();
  });

  // guards: BR-SETL-012
  it('PDF: акт шукається за id + організація + контрагент; не знайдено → NotFound, PDF не будується', async () => {
    await expect(service.generateReconciliationPdf('org-1', 'cp-1', 'act-9')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.reconciliationAct.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'act-9', orgId: 'org-1', counterpartyId: 'cp-1' } }),
    );
    expect(pdf.generateReconciliationActPdf).not.toHaveBeenCalled();
  });
});
