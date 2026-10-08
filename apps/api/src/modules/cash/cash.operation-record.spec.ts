/**
 * Що саме потрапляє в журнал каси і як його читають: сума (BR-CASH-004), пошук зміни
 * фіскальної каси (BR-CASH-005), стаття (BR-CASH-007, BR-CASH-008), конкурентний конфлікт
 * (BR-CASH-011), прив'язка до документа (BR-CASH-012), аудит (BR-CASH-013), історія (BR-CASH-015).
 *
 * Доповнює `cash.service.spec.ts`: там — основні гілки createOperation, тут — те, чого вони
 * не розрізняли (умова запиту, текст помилки, точний вміст рядка).
 */
import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ORG, REG, USER, opRow, setup } from './cash.spec-fixture';

describe('CashService.createOperation — сума операції', () => {
  // guards: BR-CASH-004
  it.each([
    ['від’ємна', -100],
    ['мінус копійка', -0.01],
    ['менша за пів копійки (округлюється до 0)', 0.004],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])(
    'сума %s → 400 «Сума має бути додатною», касу не читаємо, нічого не пишемо',
    async (_n, amount) => {
      const { m, service } = setup();
      await expect(
        service.createOperation(ORG, {
          cashRegisterId: REG,
          direction: 'IN',
          amount,
          reason: 'MANUAL_IN',
        }),
      ).rejects.toThrow(/Сума має бути додатною/);
      expect(m.prisma.cashRegister.findFirst).not.toHaveBeenCalled();
      expect(m.prisma.cashOperation.create).not.toHaveBeenCalled();
    },
  );

  // guards: BR-CASH-004
  it('сума округлюється до копійки ДО запису й конвертації (10.126 → 10.13)', async () => {
    const { m, service } = setup();
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 10.126,
      reason: 'MANUAL_IN',
    });
    expect(m.exchangeRates.resolveBaseConversion.mock.calls[0][3]).toBe(10.13);
    expect(m.prisma.cashOperation.create.mock.calls[0][0].data.amount).toBe(10.13);
  });

  // guards: BR-CASH-004
  it('знак несе direction: OUT пишеться з ДОДАТНОЮ сумою', async () => {
    const { m, service } = setup();
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'OUT',
      amount: 250,
      reason: 'MANUAL_OUT',
    });
    expect(m.prisma.cashOperation.create.mock.calls[0][0].data).toMatchObject({
      direction: 'OUT',
      amount: 250,
    });
  });
});

describe('CashService.createOperation — зміна фіскальної каси', () => {
  // guards: BR-CASH-003, BR-CASH-005
  it('шукає ВІДКРИТУ невидалену зміну саме цієї каси в цій організації', async () => {
    const { m, service } = setup({ isFiscal: true });
    m.prisma.cashShift.findFirst.mockResolvedValueOnce({ id: 'shift-1' });
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 100,
      reason: 'MANUAL_IN',
    });
    expect(m.prisma.cashShift.findFirst.mock.calls[0][0].where).toEqual({
      orgId: ORG,
      cashRegisterId: REG,
      status: 'OPEN',
      deletedAt: null,
    });
  });

  // guards: BR-CASH-005
  it('без відкритої зміни → 400 з підказкою відкрити зміну', async () => {
    const { m, service } = setup({ isFiscal: true });
    m.prisma.cashShift.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'IN',
        amount: 100,
        reason: 'SALE_PAYMENT',
      }),
    ).rejects.toThrow(/відкрийте зміну/);
    expect(m.prisma.cashOperation.create).not.toHaveBeenCalled();
  });
});

describe('CashService — стаття руху коштів', () => {
  // guards: BR-CASH-007
  it('стаття не знайдена → 404 «Статтю не знайдено» (не 404 каси), нічого не пишемо', async () => {
    const { m, service } = setup();
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'OUT',
        amount: 100,
        reason: 'EXPENSE',
        expenseCategoryId: 'cat-x',
      }),
    ).rejects.toThrow(/Статтю не знайдено/);
    expect(m.prisma.cashOperation.create).not.toHaveBeenCalled();
  });

  // guards: BR-CASH-007
  it('без статті операція проходить, статтю не шукаємо, expenseCategoryId = null', async () => {
    const { m, service } = setup();
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'OUT',
      amount: 100,
      reason: 'MANUAL_OUT',
    });
    expect(m.prisma.expenseCategory.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.cashOperation.create.mock.calls[0][0].data.expenseCategoryId).toBeNull();
  });

  // guards: BR-CASH-008
  it('createManual: EXPENSE без статті → 400 «Для витрати вкажіть статтю витрат», касу не читаємо', async () => {
    const { m, service } = setup();
    await expect(
      service.createManual(ORG, REG, { direction: 'OUT', amount: 100, reason: 'EXPENSE' } as never),
    ).rejects.toThrow(/Для витрати вкажіть статтю витрат/);
    expect(m.prisma.cashRegister.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.cashOperation.create).not.toHaveBeenCalled();
  });

  // guards: BR-CASH-008
  it('createManual: інша причина (MANUAL_OUT) без статті → проходить', async () => {
    const { m, service } = setup();
    await service.createManual(ORG, REG, {
      direction: 'OUT',
      amount: 100,
      reason: 'MANUAL_OUT',
    } as never);
    expect(m.prisma.cashOperation.create).toHaveBeenCalledTimes(1);
  });
});

describe('CashService.createOperation — конкурентний конфлікт', () => {
  const p2034 = () =>
    new Prisma.PrismaClientKnownRequestError('could not serialize access', {
      code: 'P2034',
      clientVersion: 'test',
    });

  // guards: BR-CASH-011
  it('P2034 (serialization failure) → 400 «Каса зайнята паралельною операцією»', async () => {
    const { m, service } = setup();
    m.prisma.$transaction.mockRejectedValueOnce(p2034());
    const call = service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'OUT',
      amount: 100,
      reason: 'MANUAL_OUT',
    });
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/Каса зайнята паралельною операцією/);
  });

  // guards: BR-CASH-011
  it('інша помилка БД не маскується під 400 — летить як є', async () => {
    const { m, service } = setup();
    const boom = new Error('connection lost');
    m.prisma.$transaction.mockRejectedValueOnce(boom);
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'OUT',
        amount: 100,
        reason: 'MANUAL_OUT',
      }),
    ).rejects.toBe(boom);
  });

  // guards: BR-CASH-006, BR-CASH-011
  it('зовнішній tx: каса, баланс і запис ідуть через НЬОГО, а не через this.prisma', async () => {
    const { m, service } = setup();
    const outer = setup({ balance: 500 }).m.prisma;
    await service.createOperation(
      ORG,
      { cashRegisterId: REG, direction: 'OUT', amount: 100, reason: 'PAYROLL' },
      outer as never,
    );
    expect(outer.cashRegister.findFirst).toHaveBeenCalled();
    expect(outer.cashOperation.aggregate).toHaveBeenCalled();
    expect(outer.cashOperation.create).toHaveBeenCalledTimes(1);
    expect(m.prisma.cashRegister.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.cashOperation.aggregate).not.toHaveBeenCalled();
    expect(m.prisma.cashOperation.create).not.toHaveBeenCalled();
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('CashService — прив’язка операції до документа', () => {
  // guards: BR-CASH-012
  it('documentType/documentId/counterpartyId/employeeId/notes/createdBy пишуться як передані', async () => {
    const { m, service } = setup();
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'OUT',
      amount: 100,
      reason: 'PAYROLL',
      counterpartyId: 'cp-1',
      employeeId: 'emp-1',
      documentType: 'PayrollPeriod',
      documentId: 'doc-1',
      notes: 'аванс',
      createdBy: USER,
    });
    expect(m.prisma.cashOperation.create.mock.calls[0][0].data).toMatchObject({
      reason: 'PAYROLL',
      counterpartyId: 'cp-1',
      employeeId: 'emp-1',
      documentType: 'PayrollPeriod',
      documentId: 'doc-1',
      notes: 'аванс',
      createdBy: USER,
    });
  });

  // guards: BR-CASH-012
  it('непередані поля прив’язки пишуться як null', async () => {
    const { m, service } = setup();
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 100,
      reason: 'MANUAL_IN',
    });
    expect(m.prisma.cashOperation.create.mock.calls[0][0].data).toMatchObject({
      counterpartyId: null,
      employeeId: null,
      documentType: null,
      documentId: null,
      notes: null,
      createdBy: null,
    });
  });

  // guards: BR-CASH-012
  it('createManual: автор = користувач запиту; документ і співробітник не задаються', async () => {
    const { m, service } = setup();
    await service.createManual(
      ORG,
      REG,
      {
        direction: 'IN',
        amount: 100,
        reason: 'MANUAL_IN',
        counterpartyId: 'cp-1',
        notes: 'здача',
      } as never,
      USER,
    );
    expect(m.prisma.cashOperation.create.mock.calls[0][0].data).toMatchObject({
      cashRegisterId: REG,
      createdBy: USER,
      counterpartyId: 'cp-1',
      notes: 'здача',
      employeeId: null,
      documentType: null,
      documentId: null,
    });
  });
});

describe('CashService.createOperation — аудит', () => {
  // guards: BR-CASH-013
  it('є автор → запис CREATE в аудит із напрямом, сумою і причиною', async () => {
    const { m, service } = setup();
    m.prisma.cashOperation.create.mockResolvedValueOnce(opRow({ id: 'op-77' }));
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 100,
      reason: 'MANUAL_IN',
      createdBy: USER,
    });
    expect(m.audit.record).toHaveBeenCalledTimes(1);
    expect(m.audit.record).toHaveBeenCalledWith(
      ORG,
      'CashOperation',
      'op-77',
      'CREATE',
      USER,
      undefined,
      { direction: 'IN', amount: 100, reason: 'MANUAL_IN' },
    );
  });

  // guards: BR-CASH-013
  it('автора немає → в аудит нічого не пишеться', async () => {
    const { m, service } = setup();
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 100,
      reason: 'SALE_PAYMENT',
    });
    expect(m.audit.record).not.toHaveBeenCalled();
  });

  // guards: BR-CASH-013
  it('збій аудиту не валить операцію — вона вже записана', async () => {
    const { m, service } = setup();
    // Аудит не чекають (fire-and-forget), тож незаглушений збій не впав би в `await` нижче,
    // а вилетів би як unhandledRejection — ловимо саме його. Звичайна функція, не `vi.fn()`:
    // vitest сам чіпляє обробник до промісу з мока (settledResults), і той уже не «unhandled».
    let auditCalls = 0;
    m.audit.record = (() => {
      auditCalls += 1;
      return Promise.reject(new Error('audit down'));
    }) as never;
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const res = await service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'IN',
        amount: 100,
        reason: 'MANUAL_IN',
        createdBy: USER,
      });
      expect(res.id).toBe('op-1');
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(auditCalls).toBe(1);
    expect(unhandled).toEqual([]);
  });
});

describe('CashService.listOperations — історія операцій', () => {
  // guards: BR-CASH-015
  it('найновіші першими, за замовчуванням не більше 100 рядків', async () => {
    const { m, service } = setup();
    m.prisma.cashOperation.findMany.mockResolvedValueOnce([]);
    await service.listOperations(ORG, REG);
    expect(m.prisma.cashOperation.findMany.mock.calls[0][0]).toMatchObject({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });

  // guards: BR-CASH-015
  it('запит понад стелю (10000) обрізається до 500; менший ліміт (20) лишається', async () => {
    const { m, service } = setup();
    m.prisma.cashOperation.findMany.mockResolvedValue([]);
    await service.listOperations(ORG, REG, 10000);
    await service.listOperations(ORG, REG, 20);
    expect(m.prisma.cashOperation.findMany.mock.calls[0][0].take).toBe(500);
    expect(m.prisma.cashOperation.findMany.mock.calls[1][0].take).toBe(20);
  });

  // guards: BR-CASH-015
  it('рядок історії: числа — number, дата — ISO, назва статті — з довідника', async () => {
    const { m, service } = setup();
    m.prisma.cashOperation.findMany.mockResolvedValueOnce([
      opRow({
        direction: 'OUT',
        amount: new Prisma.Decimal('150.50'),
        amountBase: new Prisma.Decimal('150.50'),
        rateUsed: new Prisma.Decimal('1'),
        reason: 'EXPENSE',
        expenseCategoryId: 'cat-1',
        expenseCategory: { name: 'Оренда' },
      }),
    ]);
    const [row] = await service.listOperations(ORG, REG);
    expect(row).toMatchObject({
      direction: 'OUT',
      amount: 150.5,
      amountBase: 150.5,
      rateUsed: 1,
      reason: 'EXPENSE',
      expenseCategoryId: 'cat-1',
      expenseCategoryName: 'Оренда',
      createdAt: '2026-10-08T09:00:00.000Z',
    });
  });

  // Пошук і відбір за датою в історії операцій (рішення власника 2026-10-09).
  it('dateFrom/dateTo → межі КИЇВСЬКОЇ доби за createdAt, каса й організація лишаються', async () => {
    const { m, service } = setup();
    m.prisma.cashOperation.findMany.mockResolvedValueOnce([]);

    await service.listOperations(ORG, REG, 100, { dateFrom: '2026-10-09', dateTo: '2026-10-09' });

    expect(m.prisma.cashOperation.findMany.mock.calls[0][0].where).toEqual({
      orgId: ORG,
      cashRegisterId: REG,
      createdAt: {
        gte: new Date('2026-10-08T21:00:00.000Z'),
        lte: new Date('2026-10-09T20:59:59.999Z'),
      },
    });
  });

  it('q → примітка АБО назва статті витрат; без урахування регістру', async () => {
    const { m, service } = setup();
    m.prisma.cashOperation.findMany.mockResolvedValueOnce([]);

    await service.listOperations(ORG, REG, 100, { q: ' оренда ' });

    const where = m.prisma.cashOperation.findMany.mock.calls[0][0].where;
    expect(where.orgId).toBe(ORG);
    expect(where.cashRegisterId).toBe(REG);
    expect(where.OR).toEqual([
      { notes: { contains: 'оренда', mode: 'insensitive' } },
      { expenseCategory: { name: { contains: 'оренда', mode: 'insensitive' } } },
    ]);
  });

  it('q із символами підстановки LIKE (% _) шукається буквально', async () => {
    const { m, service } = setup();
    m.prisma.cashOperation.findMany.mockResolvedValueOnce([]);

    await service.listOperations(ORG, REG, 100, { q: '5%_' });

    const contains = { contains: '5\\%\\_', mode: 'insensitive' };
    expect(m.prisma.cashOperation.findMany.mock.calls[0][0].where.OR).toEqual([
      { notes: contains },
      { expenseCategory: { name: contains } },
    ]);
  });

  // guards: BR-CASH-015
  it.each([
    [Number.NaN, 100],
    [0, 100],
    [-5, 100],
    [Number.POSITIVE_INFINITY, 100],
    [20.9, 20],
  ])('limit із query-рядка %s → take %s (не NaN і не відʼємне)', async (limit, take) => {
    const { m, service } = setup();
    m.prisma.cashOperation.findMany.mockResolvedValueOnce([]);

    await service.listOperations(ORG, REG, limit);

    expect(m.prisma.cashOperation.findMany.mock.calls[0][0].take).toBe(take);
  });

  it('без фільтрів where — як раніше: лише організація і каса', async () => {
    const { m, service } = setup();
    m.prisma.cashOperation.findMany.mockResolvedValueOnce([]);

    await service.listOperations(ORG, REG);

    expect(m.prisma.cashOperation.findMany.mock.calls[0][0].where).toEqual({
      orgId: ORG,
      cashRegisterId: REG,
    });
  });
});
