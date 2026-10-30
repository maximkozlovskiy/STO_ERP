/**
 * Акт звірки (SettlementsAccountService.createReconciliationAct / generateReconciliationPdf).
 * Правила BR-SETL-006, BR-SETL-011, BR-SETL-012 — docs/objects/settlements.md.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, it, expect, beforeEach, vi } from 'vitest';
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

  // До 2026-10-08 закриваючий баланс брався з поточного залишку: акт за липень, сформований
  // у вересні, показував вересневий залишок, і клієнт підписував не ті цифри.
  // guards: BR-SETL-011
  it('акт за минулий період: закриваючий = залишок на КІНЕЦЬ періоду (поточний мінус усе пізніше)', async () => {
    // Поточний баланс 1000. У липні: +300 −100 = +200. Після липня: +500 (CHARGE) −50 (PAYMENT) = +450.
    prisma.settlementTransaction.findMany.mockResolvedValue([
      txRow({ type: 'CHARGE', amount: '300.00', amountBase: '300.00' }),
      txRow({ type: 'PAYMENT', amount: '100.00', amountBase: '100.00' }),
    ]);
    prisma.settlementTransaction.groupBy.mockImplementation(
      ({ where }: { where: { amountBase: unknown } }) =>
        Promise.resolve(
          where.amountBase === null
            ? []
            : [
                { type: 'CHARGE', _sum: { amountBase: '500.00' } },
                { type: 'PAYMENT', _sum: { amountBase: '50.00' } },
              ],
        ),
    );

    const act = await service.createReconciliationAct('org-1', 'cp-1', period);

    expect(act.closingBalance).toBe(550); // 1000 − 450
    expect(act.openingBalance).toBe(350); // 550 − 200
  });

  // guards: BR-SETL-011, BR-SETL-006
  it('транзакції після періоду: лише свій рахунок і організація, строго ПІСЛЯ кінця періоду; історичні без amountBase — сумою amount', async () => {
    prisma.settlementTransaction.groupBy.mockImplementation(
      ({ where }: { where: { amountBase: unknown } }) =>
        Promise.resolve(
          where.amountBase === null ? [{ type: 'PAYMENT', _sum: { amount: '70.00' } }] : [],
        ),
    );

    const act = await service.createReconciliationAct('org-1', 'cp-1', period);

    expect(act.closingBalance).toBe(1070); // 1000 − (−70)
    const to = new Date('2026-07-31T20:59:59.999Z');
    expect(prisma.settlementTransaction.groupBy).toHaveBeenCalledTimes(2);
    for (const call of prisma.settlementTransaction.groupBy.mock.calls) {
      expect(call[0].where).toMatchObject({
        settlementAccountId: 'acc-1',
        orgId: 'org-1',
        createdAt: { gt: to },
      });
    }
  });

  // guards: BR-SETL-011
  it('після періоду нічого не було → закриваючий = поточний баланс', async () => {
    const act = await service.createReconciliationAct('org-1', 'cp-1', period);
    expect(act.closingBalance).toBe(1000);
    expect(act.openingBalance).toBe(1000);
  });

  // Баланс, журнал періоду й агрегат «після періоду» мусять бути з одного знімка БД: інакше
  // платіж, проведений між читаннями, зсуває закриваючий залишок рівно на свою суму.
  // guards: BR-SETL-011
  it('баланс і журнал читаються з одного знімка: RepeatableRead, баланс — той, що прочитано в транзакції', async () => {
    prisma.settlementAccount.findFirst
      .mockResolvedValueOnce({ id: 'acc-1', balance: '1000.00' }) // перевірка існування рахунку
      .mockResolvedValueOnce({ balance: '1200.00' }); // знімок усередині транзакції

    const act = await service.createReconciliationAct('org-1', 'cp-1', period);

    expect(act.closingBalance).toBe(1200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][1]).toMatchObject({
      isolationLevel: 'RepeatableRead',
    });
    expect(prisma.settlementAccount.findFirst).toHaveBeenLastCalledWith({
      where: { id: 'acc-1', orgId: 'org-1' },
      select: { balance: true },
    });
  });

  // guards: BR-SETL-011
  it('у періоді понад 5000 транзакцій → 400 «звузьте період», акт не створюється (не обрізаємо мовчки)', async () => {
    prisma.settlementTransaction.findMany.mockResolvedValue(
      Array.from({ length: 5001 }, () => txRow()),
    );

    await expect(service.createReconciliationAct('org-1', 'cp-1', period)).rejects.toThrow(
      'У періоді понад 5000 транзакцій — звузьте період акта звірки',
    );
    expect(prisma.reconciliationAct.create).not.toHaveBeenCalled();
  });

  // guards: BR-SETL-011
  it('рівно 5000 транзакцій у періоді — акт створюється з усіма рядками', async () => {
    prisma.settlementTransaction.findMany.mockResolvedValue(
      Array.from({ length: 5000 }, () => txRow({ amount: '1.00', amountBase: '1.00' })),
    );

    const act = await service.createReconciliationAct('org-1', 'cp-1', period);

    expect(act.transactions).toHaveLength(5000);
    expect(act.openingBalance).toBe(-4000); // 1000 − 5000 × 1
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
  // Раніше обидві межі рахувались зсувом ПОЛУДНЯ: у день переведення годинника північ має інший
  // зсув, тож 29.03 акт захоплював останню годину 28.03, а 25.10 губив першу годину доби.
  // Mutation-verify: повернути зсув полудня на початок доби → обидва кейси падають.
  it.each([
    ['2026-03-29', '2026-03-28T22:00:00.000Z', '2026-03-29T20:59:59.999Z'],
    ['2026-10-25', '2026-10-24T21:00:00.000Z', '2026-10-25T21:59:59.999Z'],
  ])('день переведення годинника %s — межі справжньої київської доби', async (day, gte, lte) => {
    await service.createReconciliationAct('org-1', 'cp-1', { periodFrom: day, periodTo: day });

    expect(prisma.settlementTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdAt: { gte: new Date(gte), lte: new Date(lte) } }),
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

  // Bug #822: перевернутий період зберігався актом (201) без рядків, з periodFrom > periodTo.
  it('початок періоду пізніше за кінець → BadRequest, акт не створюється і база не читається', async () => {
    await expect(
      service.createReconciliationAct('org-1', 'cp-1', {
        periodFrom: '2026-07-31',
        periodTo: '2026-07-01',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.settlementAccount.findFirst).not.toHaveBeenCalled();
    expect(prisma.reconciliationAct.create).not.toHaveBeenCalled();
  });

  it('період з одного дня (початок = кінець) приймається', async () => {
    prisma.settlementTransaction.findMany.mockResolvedValue([]);
    await expect(
      service.createReconciliationAct('org-1', 'cp-1', {
        periodFrom: '2026-07-01',
        periodTo: '2026-07-01',
      }),
    ).resolves.toBeDefined();
    expect(prisma.reconciliationAct.create).toHaveBeenCalledTimes(1);
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

  it('PDF: шапка акта — реквізити СВОЄЇ організації з OrgPrintInfoService, без змін', async () => {
    const fx = makeAccountFixture();
    const orgInfo = { name: 'СТО Альфа', ipn: '123456789012', logo: 'data:image/png;base64,AA' };
    fx.orgPrintInfo.get.mockResolvedValue(orgInfo);
    fx.prisma.reconciliationAct.findFirst.mockResolvedValue({
      periodFrom: new Date('2026-07-01T00:00:00Z'),
      periodTo: new Date('2026-07-31T00:00:00Z'),
      openingBalance: '0',
      closingBalance: '0',
      snapshotJson: [],
      counterparty: { firstName: null, lastName: null, companyName: 'ТОВ Бета' },
    });

    await fx.service.generateReconciliationPdf('org-1', 'cp-1', 'act-1');

    expect(fx.orgPrintInfo.get).toHaveBeenCalledWith('org-1');
    expect(fx.pdf.generateReconciliationActPdf.mock.calls[0]?.[0]).toMatchObject({ org: orgInfo });
  });

  /**
   * BR-SETL-016 (TECH-DEBT §11 п. 7): колонка «Документ» друкувала сирий тип моделі (`WorkOrder`)
   * без номера. Тепер — вид українською і номер документа рядка. Фейкові таблиці документів нижче
   * ВИКОНУЮТЬ `where` (id з переліку + організація) — чужий документ номера не дає.
   */
  describe('PDF: колонка «Документ» — вид і номер', () => {
    type Doc = { id: string; orgId: string; number: string };
    const table = (rows: Doc[]) => ({
      findMany: vi.fn(({ where }: { where: { id: { in: string[] }; orgId: string } }) =>
        Promise.resolve(
          rows
            .filter(r => where.id.in.includes(r.id) && r.orgId === where.orgId)
            .map(r => ({ id: r.id, number: r.number })),
        ),
      ),
    });

    function printed(snapshot: Array<Record<string, unknown>>) {
      const fx = makeAccountFixture();
      Object.assign(fx.prisma, {
        invoice: table([{ id: 'inv-1', orgId: 'org-1', number: 'РФ-000007' }]),
        workOrder: table([
          { id: 'wo-1', orgId: 'org-1', number: 'НЗ-000012' },
          { id: 'wo-x', orgId: 'org-2', number: 'НЗ-ЧУЖИЙ' },
        ]),
        purchaseOrder: table([{ id: 'po-1', orgId: 'org-1', number: 'ЗП-000003' }]),
        supplierPayment: table([]),
        supplierReturn: table([]),
      });
      fx.prisma.reconciliationAct.findFirst.mockResolvedValue({
        periodFrom: new Date('2026-07-01T00:00:00Z'),
        periodTo: new Date('2026-07-31T00:00:00Z'),
        openingBalance: '0',
        closingBalance: '0',
        snapshotJson: snapshot,
        counterparty: { firstName: null, lastName: null, companyName: 'ТОВ Бета' },
      });
      return fx.service.generateReconciliationPdf('org-1', 'cp-1', 'act-1').then(() => {
        const data = fx.pdf.generateReconciliationActPdf.mock.calls[0]![0] as {
          transactions: Array<{ document?: string }>;
        };
        return data.transactions.map(t => t.document);
      });
    }

    const row = (documentType: string | null, documentId: string | null) => ({
      date: '2026-07-10T09:00:00.000Z',
      type: 'CHARGE',
      amount: 100,
      amountBase: 100,
      documentType,
      documentId,
    });

    // guards: BR-SETL-016
    it('наряд, рахунок, замовлення — «вид № номер»; оплата без номера — лише вид; без документа — порожньо', async () => {
      expect(
        await printed([
          row('WorkOrder', 'wo-1'),
          row('Invoice', 'inv-1'),
          row('PurchaseOrder', 'po-1'),
          row('Payment', 'pay-1'),
          row(null, null),
        ]),
      ).toEqual([
        'Наряд № НЗ-000012',
        'Рахунок № РФ-000007',
        'Замовлення постачальнику № ЗП-000003',
        'Оплата',
        '',
      ]);
    });

    // guards: BR-SETL-016
    it('документ чужої організації номера не дає (where несе orgId); сирого «WorkOrder» немає', async () => {
      const docs = await printed([row('WorkOrder', 'wo-x')]);
      expect(docs).toEqual(['Наряд']);
      expect(docs.join()).not.toContain('WorkOrder');
    });
  });
});
