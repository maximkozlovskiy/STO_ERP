/**
 * Ізоляція організацій у касі (BR-CASH-003): кожне читання і кожен запис CashService несе
 * `orgId` викликача, а каса і стаття шукаються лише серед НЕвидалених записів цієї організації.
 *
 * Наявні кейси «каса не належить org → 404» у `cash.service.spec.ts` повертають з мока `null`
 * і не дивляться на `where` — прибери з нього `orgId`, і вони лишаться зеленими. Тому тут
 * перевіряється саме умова запиту.
 */
import { describe, it, expect } from 'vitest';
import { ORG, REG, setup } from './cash.spec-fixture';

describe('CashService — ізоляція організацій (where/data несуть orgId)', () => {
  // guards: BR-CASH-003
  it('createOperation шукає касу за id + orgId серед невидалених', async () => {
    const { m, service } = setup();
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 100,
      reason: 'MANUAL_IN',
    });
    expect(m.prisma.cashRegister.findFirst.mock.calls[0][0].where).toEqual({
      id: REG,
      orgId: ORG,
      deletedAt: null,
    });
  });

  // guards: BR-CASH-003
  it('операція пишеться з orgId викликача і в касу, знайдену в цій організації', async () => {
    const { m, service } = setup();
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 100,
      reason: 'MANUAL_IN',
    });
    expect(m.prisma.cashOperation.create.mock.calls[0][0].data).toMatchObject({
      orgId: ORG,
      cashRegisterId: REG,
    });
  });

  // guards: BR-CASH-003, BR-CASH-007
  it('стаття шукається за id + orgId серед невидалених', async () => {
    const { m, service } = setup();
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce({ type: 'INCOME', isActive: true });
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 100,
      reason: 'MANUAL_IN',
      expenseCategoryId: 'cat-1',
    });
    expect(m.prisma.expenseCategory.findFirst.mock.calls[0][0].where).toEqual({
      id: 'cat-1',
      orgId: ORG,
      deletedAt: null,
    });
  });

  // guards: BR-CASH-003
  it('getBalance шукає касу за id + orgId серед невидалених', async () => {
    const { m, service } = setup();
    await service.getBalance(ORG, REG);
    expect(m.prisma.cashRegister.findFirst.mock.calls[0][0].where).toEqual({
      id: REG,
      orgId: ORG,
      deletedAt: null,
    });
  });

  // guards: BR-CASH-003
  it('listOperations фільтрує історію за orgId і касою', async () => {
    const { m, service } = setup();
    m.prisma.cashOperation.findMany.mockResolvedValueOnce([]);
    await service.listOperations(ORG, REG);
    expect(m.prisma.cashOperation.findMany.mock.calls[0][0].where).toEqual({
      orgId: ORG,
      cashRegisterId: REG,
    });
  });
});
