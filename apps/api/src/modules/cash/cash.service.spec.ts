import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CashService } from './cash.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const REG = '22222222-2222-4222-8222-222222222222';

function makeMocks() {
  return {
    prisma: {
      cashRegister: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        findFirstOrThrow: vi.fn(),
      },
      cashShift: { findFirst: vi.fn() },
      cashOperation: { create: vi.fn(), findMany: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn() },
      expenseCategory: { findFirst: vi.fn() },
      garageBranch: { findFirst: vi.fn() },
      currency: { findFirst: vi.fn() },
      $transaction: vi.fn(),
    },
    audit: { record: vi.fn().mockResolvedValue(undefined) },
    // Мультивалюта: за замовч. базова каса (UAH) → base=amount, rate=1. Тести валют перекривають.
    exchangeRates: {
      resolveBaseConversion: vi
        .fn()
        .mockImplementation((_o: string, _c: string, _d: Date, amount: number) =>
          Promise.resolve({ rateUsed: 1, amountBase: amount }),
        ),
    },
  };
}
function makeService(m: ReturnType<typeof makeMocks>): CashService {
  const s = new CashService(
    m.prisma as unknown as PrismaService,
    m.audit as unknown as AuditService,
    m.exchangeRates as unknown as import('../exchange-rates/exchange-rates.service').ExchangeRatesService,
  );
  // $transaction прокидає callback з тим самим prisma-моком (client = prisma).
  m.prisma.$transaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) =>
    fn(m.prisma),
  );
  return s;
}

describe('CashService.createOperation — єдина точка руху', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: CashService;
  beforeEach(() => {
    m = makeMocks();
    service = makeService(m);
    // Overdraft-guard читає баланс для OUT: за замовчуванням каса має вдосталь готівки
    // (initialBalance=100000, нульові агрегати) — конкретні тести перекривають за потреби.
    m.prisma.cashOperation.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    m.prisma.cashOperation.create.mockResolvedValue({
      id: 'op-1',
      cashRegisterId: REG,
      cashShiftId: null,
      direction: 'IN',
      amount: 500,
      reason: 'MANUAL_IN',
      expenseCategoryId: null,
      counterpartyId: null,
      employeeId: null,
      documentType: null,
      documentId: null,
      notes: null,
      createdAt: new Date(),
      expenseCategory: null,
    });
  });

  // guards: BR-CASH-005
  it('нефіскальна каса → операція без зміни (cashShiftId=null)', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({
      id: REG,
      isFiscal: false,
      branchId: 'b1',
    });
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 500,
      reason: 'MANUAL_IN',
    });
    expect(m.prisma.cashShift.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.cashOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cashShiftId: null, direction: 'IN', amount: 500 }),
      }),
    );
  });

  // guards: BR-CASH-010
  it('мультивалюта: UAH-каса → amountBase=amount, rateUsed=1 (базова)', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({
      id: REG,
      isFiscal: false,
      branchId: 'b1',
      currencyId: 'uah-id',
    });
    // дефолтний resolveBaseConversion-мок → {rateUsed:1, amountBase:amount}
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 500,
      reason: 'MANUAL_IN',
    });
    expect(m.exchangeRates.resolveBaseConversion).toHaveBeenCalledWith(
      ORG,
      'uah-id',
      expect.any(Date),
      500,
    );
    expect(m.prisma.cashOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amount: 500, amountBase: 500, rateUsed: 1 }),
      }),
    );
  });

  // guards: BR-CASH-010
  it('мультивалюта: USD-каса → amountBase = amount×rate (з конвертації)', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({
      id: REG,
      isFiscal: false,
      branchId: 'b1',
      currencyId: 'usd-id',
    });
    m.exchangeRates.resolveBaseConversion.mockResolvedValueOnce({
      rateUsed: 41.5,
      amountBase: 4150,
    });
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 100,
      reason: 'MANUAL_IN',
    });
    expect(m.prisma.cashOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amount: 100, amountBase: 4150, rateUsed: 41.5 }),
      }),
    );
  });

  // guards: BR-CASH-010
  it('мультивалюта: немає курсу на дату → 400 (resolveBaseConversion кидає), операція не створюється', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({
      id: REG,
      isFiscal: false,
      branchId: 'b1',
      currencyId: 'usd-id',
    });
    m.exchangeRates.resolveBaseConversion.mockRejectedValueOnce(
      new BadRequestException('Немає курсу валюти USD'),
    );
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'IN',
        amount: 100,
        reason: 'MANUAL_IN',
      }),
    ).rejects.toThrow(/Немає курсу валюти/);
    expect(m.prisma.cashOperation.create).not.toHaveBeenCalled();
  });

  // guards: BR-CASH-005
  it('фіскальна каса без відкритої зміни → BadRequest', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({
      id: REG,
      isFiscal: true,
      branchId: 'b1',
    });
    m.prisma.cashShift.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'IN',
        amount: 100,
        reason: 'MANUAL_IN',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(m.prisma.cashOperation.create).not.toHaveBeenCalled();
  });

  // guards: BR-CASH-005
  it('фіскальна каса з відкритою зміною → cashShiftId проставлено', async () => {
    // OUT: findFirst викликається двічі (register-guard + getBalance.initialBalance) → mockResolvedValue.
    m.prisma.cashRegister.findFirst.mockResolvedValue({
      id: REG,
      isFiscal: true,
      branchId: 'b1',
      initialBalance: 100000,
    });
    m.prisma.cashShift.findFirst.mockResolvedValueOnce({ id: 'shift-1' });
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'OUT',
      amount: 100,
      reason: 'PAYROLL',
    });
    expect(m.prisma.cashOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cashShiftId: 'shift-1' }) }),
    );
  });

  // guards: BR-CASH-003
  it('каса не належить org → 404', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'IN',
        amount: 100,
        reason: 'MANUAL_IN',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  // guards: BR-CASH-004
  it('amount ≤ 0 → BadRequest', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({
      id: REG,
      isFiscal: false,
      branchId: 'b1',
    });
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'IN',
        amount: 0,
        reason: 'MANUAL_IN',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('expenseCategoryId не належить org → 404', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({
      id: REG,
      isFiscal: false,
      branchId: 'b1',
    });
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'OUT',
        amount: 100,
        reason: 'EXPENSE',
        expenseCategoryId: 'cat-x',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  // guards: BR-CASH-007
  it('тип↔напрям: OUT + стаття EXPENSE → ок', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValue({
      id: REG,
      isFiscal: false,
      branchId: 'b1',
      initialBalance: 100000,
    });
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce({ type: 'EXPENSE', isActive: true });
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'OUT',
      amount: 100,
      reason: 'EXPENSE',
      expenseCategoryId: 'cat-e',
    });
    expect(m.prisma.cashOperation.create).toHaveBeenCalled();
  });

  // guards: BR-CASH-007
  it('тип↔напрям: OUT + стаття INCOME → 400 (для видачі оберіть статтю витрат)', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({
      id: REG,
      isFiscal: false,
      branchId: 'b1',
    });
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce({ type: 'INCOME', isActive: true });
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'OUT',
        amount: 100,
        reason: 'MANUAL_OUT',
        expenseCategoryId: 'cat-i',
      }),
    ).rejects.toThrow(/статтю витрат/);
    expect(m.prisma.cashOperation.create).not.toHaveBeenCalled();
  });

  // guards: BR-CASH-007
  it('тип↔напрям: IN + стаття INCOME → ок; IN + EXPENSE → 400', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValue({ id: REG, isFiscal: false, branchId: 'b1' });
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce({ type: 'INCOME', isActive: true });
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 100,
      reason: 'MANUAL_IN',
      expenseCategoryId: 'cat-i',
    });
    expect(m.prisma.cashOperation.create).toHaveBeenCalled();

    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce({ type: 'EXPENSE', isActive: true });
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'IN',
        amount: 100,
        reason: 'MANUAL_IN',
        expenseCategoryId: 'cat-e',
      }),
    ).rejects.toThrow(/статтю оприбуткування/);
  });

  // Bug #735: вимкнена стаття (isActive=false) не приймається для НОВОЇ операції.
  // guards: BR-CASH-007
  it('вимкнена стаття (isActive=false) → 400 «Стаття вимкнена»', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValue({
      id: REG,
      isFiscal: false,
      branchId: 'b1',
      initialBalance: 100000,
    });
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce({ type: 'EXPENSE', isActive: false });
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'OUT',
        amount: 100,
        reason: 'EXPENSE',
        expenseCategoryId: 'cat-off',
      }),
    ).rejects.toThrow(/вимкнена/);
    expect(m.prisma.cashOperation.create).not.toHaveBeenCalled();
  });

  // guards: BR-CASH-011
  it('зовнішній tx → без власного $transaction', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({
      id: REG,
      isFiscal: false,
      branchId: 'b1',
    });
    const tx = {
      cashRegister: m.prisma.cashRegister,
      cashShift: m.prisma.cashShift,
      expenseCategory: m.prisma.expenseCategory,
      cashOperation: m.prisma.cashOperation,
    };
    await service.createOperation(
      ORG,
      { cashRegisterId: REG, direction: 'IN', amount: 500, reason: 'SALE_PAYMENT' },
      tx as never,
    );
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
    expect(m.prisma.cashOperation.create).toHaveBeenCalled();
  });
});

describe('CashService.createManual — EXPENSE вимагає статтю', () => {
  // guards: BR-CASH-008
  it('EXPENSE без expenseCategoryId → BadRequest', async () => {
    const m = makeMocks();
    const service = makeService(m);
    await expect(
      service.createManual(ORG, REG, { direction: 'OUT', amount: 100, reason: 'EXPENSE' } as never),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('CashService.createOperation — overdraft-guard (OUT не нижче 0)', () => {
  // Каса з залишком = initialBalance + Σ(IN) − Σ(OUT). Хелпер стаббить register (двічі: guard + getBalance)
  // + агрегати IN/OUT так, щоб поточний баланс = `balance`.
  const armBalance = (m: ReturnType<typeof makeMocks>, balance: number, isFiscal = false) => {
    m.prisma.cashRegister.findFirst.mockResolvedValue({
      id: REG,
      isFiscal,
      branchId: 'b1',
      initialBalance: balance,
    });
    // getBalance: initialBalance=balance, нульові агрегати → поточний баланс = balance.
    m.prisma.cashOperation.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    m.prisma.cashOperation.create.mockResolvedValue({
      id: 'op',
      cashRegisterId: REG,
      cashShiftId: null,
      direction: 'OUT',
      amount: 0,
      reason: 'MANUAL_OUT',
      expenseCategoryId: null,
      counterpartyId: null,
      employeeId: null,
      documentType: null,
      documentId: null,
      notes: null,
      createdAt: new Date(),
      expenseCategory: null,
    });
  };

  // guards: BR-CASH-006
  it('OUT перевищує залишок → 400 «Недостатньо готівки», операція не створюється', async () => {
    const m = makeMocks();
    const service = makeService(m);
    armBalance(m, 100); // у касі 100
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'OUT',
        amount: 150,
        reason: 'MANUAL_OUT',
      }),
    ).rejects.toThrow(/Недостатньо готівки/);
    expect(m.prisma.cashOperation.create).not.toHaveBeenCalled();
  });

  // guards: BR-CASH-006
  it('OUT рівно на залишок → проходить (баланс → 0)', async () => {
    const m = makeMocks();
    const service = makeService(m);
    armBalance(m, 100);
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'OUT',
      amount: 100,
      reason: 'MANUAL_OUT',
    });
    expect(m.prisma.cashOperation.create).toHaveBeenCalled();
  });

  // guards: BR-CASH-006
  it('копійкова нестача (баланс 100.00, OUT 100.01) → 400 (толеранс −0.001 не пропускає)', async () => {
    const m = makeMocks();
    const service = makeService(m);
    armBalance(m, 100);
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'OUT',
        amount: 100.01,
        reason: 'MANUAL_OUT',
      }),
    ).rejects.toThrow(/Недостатньо готівки/);
    expect(m.prisma.cashOperation.create).not.toHaveBeenCalled();
  });

  // guards: BR-CASH-006
  it('float-дрейф (баланс 0.30, OUT 0.30) → проходить (толеранс поглинає IEEE-754)', async () => {
    const m = makeMocks();
    const service = makeService(m);
    // 0.1+0.2 = 0.30000000000000004; після roundMoney → 0.3. OUT 0.3 → баланс 0 → ок.
    armBalance(m, 0.1 + 0.2);
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'OUT',
      amount: 0.3,
      reason: 'MANUAL_OUT',
    });
    expect(m.prisma.cashOperation.create).toHaveBeenCalled();
  });

  // guards: BR-CASH-006
  it('IN не перевіряється залишком (готівка додається навіть при 0)', async () => {
    const m = makeMocks();
    const service = makeService(m);
    armBalance(m, 0);
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 500,
      reason: 'MANUAL_IN',
    });
    expect(m.prisma.cashOperation.create).toHaveBeenCalled();
  });

  // guards: BR-CASH-006
  it('multi-OUT в одній зовнішній tx: другий OUT бачить списане першим → 400', async () => {
    const m = makeMocks();
    const service = makeService(m);
    m.prisma.cashRegister.findFirst.mockResolvedValue({
      id: REG,
      isFiscal: false,
      branchId: 'b1',
      initialBalance: 100,
    });
    // Перший OUT (60) пройшов → у t-aware агрегації OUT-сума стала 60. Другий OUT (60) читає
    // баланс 100 − 60 = 40 < 60 → блок. Емулюємо це через послідовні OUT-агрегати.
    let outSum = 0;
    m.prisma.cashOperation.aggregate.mockImplementation(
      async (arg: { where: { direction: 'IN' | 'OUT' } }) => ({
        _sum: { amount: arg.where.direction === 'OUT' ? outSum : 0 },
      }),
    );
    m.prisma.cashOperation.create.mockImplementation(async (arg: { data: { amount: number } }) => {
      outSum += arg.data.amount; // списання «застосувалось» у цій tx
      return {
        id: 'op',
        cashRegisterId: REG,
        cashShiftId: null,
        direction: 'OUT',
        amount: arg.data.amount,
        reason: 'PAYROLL',
        expenseCategoryId: null,
        counterpartyId: null,
        employeeId: null,
        documentType: null,
        documentId: null,
        notes: null,
        createdAt: new Date(),
        expenseCategory: null,
      };
    });
    const tx = {
      cashRegister: m.prisma.cashRegister,
      cashShift: m.prisma.cashShift,
      expenseCategory: m.prisma.expenseCategory,
      cashOperation: m.prisma.cashOperation,
    } as never;

    // Перший OUT 60 — проходить (баланс 100 ≥ 60).
    await service.createOperation(
      ORG,
      { cashRegisterId: REG, direction: 'OUT', amount: 60, reason: 'PAYROLL' },
      tx,
    );
    // Другий OUT 60 — тепер баланс 40 < 60 → блок.
    await expect(
      service.createOperation(
        ORG,
        { cashRegisterId: REG, direction: 'OUT', amount: 60, reason: 'PAYROLL' },
        tx,
      ),
    ).rejects.toThrow(/Недостатньо готівки/);
  });

  // guards: BR-CASH-011
  it('без-tx шлях → Serializable транзакція', async () => {
    const m = makeMocks();
    const service = makeService(m);
    armBalance(m, 1000);
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'OUT',
      amount: 100,
      reason: 'MANUAL_OUT',
    });
    expect(m.prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });
});

describe('CashService.getBalance — initial + Σ(sign)', () => {
  // guards: BR-CASH-009
  it('balance = initialBalance + IN − OUT', async () => {
    const m = makeMocks();
    const service = makeService(m);
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({ initialBalance: 1000 });
    m.prisma.cashOperation.aggregate
      .mockResolvedValueOnce({ _sum: { amount: 3000 } }) // IN
      .mockResolvedValueOnce({ _sum: { amount: 1200 } }); // OUT
    const balance = await service.getBalance(ORG, REG);
    expect(balance).toBe(2800); // 1000 + 3000 − 1200
  });

  // guards: BR-CASH-009
  it('каса не знайдена → 404', async () => {
    const m = makeMocks();
    const service = makeService(m);
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce(null);
    await expect(service.getBalance(ORG, REG)).rejects.toThrow(NotFoundException);
  });

  // guards: BR-CASH-003
  it('агрегати балансу scoped по orgId (tenant-isolation — guard не тече між org)', async () => {
    const m = makeMocks();
    const service = makeService(m);
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({ initialBalance: 0 });
    m.prisma.cashOperation.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    await service.getBalance(ORG, REG);
    for (const call of m.prisma.cashOperation.aggregate.mock.calls) {
      expect(call[0].where).toMatchObject({ orgId: ORG, cashRegisterId: REG });
    }
  });
});

describe('CashService.getBalances — пакетний баланс (perf: 1 groupBy замість 3×N)', () => {
  const REG2 = '33333333-3333-4333-8333-333333333333';

  // guards: BR-CASH-003, BR-CASH-009
  it('семантика ІДЕНТИЧНА getBalance: initial + Σ(IN) − Σ(OUT) на реєстр, один groupBy', async () => {
    const m = makeMocks();
    const service = makeService(m);
    m.prisma.cashOperation.groupBy.mockResolvedValueOnce([
      { cashRegisterId: REG, direction: 'IN', _sum: { amount: 3000 } },
      { cashRegisterId: REG, direction: 'OUT', _sum: { amount: 1200 } },
      { cashRegisterId: REG2, direction: 'IN', _sum: { amount: 500 } },
    ]);
    const balances = await service.getBalances(
      ORG,
      new Map([
        [REG, 1000],
        [REG2, 250],
      ]),
    );
    expect(balances.get(REG)).toBe(2800); // 1000 + 3000 − 1200 (= getBalance-тест вище)
    expect(balances.get(REG2)).toBe(750); // 250 + 500 − 0
    // Один запит на всі реєстри (не 2×N агрегацій).
    expect(m.prisma.cashOperation.groupBy).toHaveBeenCalledTimes(1);
    expect(m.prisma.cashOperation.aggregate).not.toHaveBeenCalled();
    expect(m.prisma.cashOperation.groupBy.mock.calls[0][0].where).toMatchObject({
      orgId: ORG,
      cashRegisterId: { in: [REG, REG2] },
    });
  });

  // guards: BR-CASH-009
  it('каса без операцій → чистий initialBalance', async () => {
    const m = makeMocks();
    const service = makeService(m);
    m.prisma.cashOperation.groupBy.mockResolvedValueOnce([]);
    const balances = await service.getBalances(ORG, new Map([[REG, 1500]]));
    expect(balances.get(REG)).toBe(1500);
  });

  it('пустий вхід → 0 запитів, пуста мапа', async () => {
    const m = makeMocks();
    const service = makeService(m);
    const balances = await service.getBalances(ORG, new Map());
    expect(balances.size).toBe(0);
    expect(m.prisma.cashOperation.groupBy).not.toHaveBeenCalled();
  });
});
