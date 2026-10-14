/**
 * Ізоляція організацій у касі (BR-CASH-003): кожне читання і кожен запис CashService несе
 * `orgId` викликача, а каса і стаття шукаються лише серед НЕвидалених записів цієї організації.
 *
 * Наявні кейси «каса не належить org → 404» у `cash.service.spec.ts` повертають з мока `null`
 * і не дивляться на `where` — прибери з нього `orgId`, і вони лишаться зеленими. Тому тут
 * перевіряється саме умова запиту.
 */
import { describe, it, expect, vi } from 'vitest';
import { ORG, REG, opRow, setup } from './cash.spec-fixture';

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

  // Рядок каси несе лише id контрагента, працівника, підстави й платіжного документа — без
  // зв'язку в схемі. Довідка за самим id показала б назву чи фіскальний статус ЧУЖОЇ організації.
  // guards: BR-CASH-003
  it('історія: назви, номери й фіскальний статус шукаються за id + orgId', async () => {
    const { m, service } = setup();
    const lookups = {
      counterparty: m.prisma.counterparty.findMany,
      employee: m.prisma.employee.findMany,
      workOrder: vi.fn().mockResolvedValue([]),
      purchaseOrder: vi.fn().mockResolvedValue([]),
      payment: vi.fn().mockResolvedValue([]),
      supplierPayment: vi.fn().mockResolvedValue([]),
    };
    Object.assign(m.prisma, {
      workOrder: { findMany: lookups.workOrder },
      purchaseOrder: { findMany: lookups.purchaseOrder },
      payment: { findMany: lookups.payment },
      supplierPayment: { findMany: lookups.supplierPayment },
    });
    m.prisma.cashOperation.findMany.mockResolvedValueOnce([
      opRow({
        counterpartyId: 'cp-1',
        employeeId: 'emp-1',
        documentType: 'Payment',
        documentId: 'pay-1',
        baseDocumentType: 'WorkOrder',
        baseDocumentId: 'wo-1',
      }),
      opRow({
        id: 'op-2',
        documentType: 'SupplierPayment',
        documentId: 'sp-1',
        baseDocumentType: 'PurchaseOrder',
        baseDocumentId: 'po-1',
      }),
    ]);

    await service.listOperations(ORG, REG);

    for (const [name, lookup] of Object.entries(lookups)) {
      expect(lookup, name).toHaveBeenCalledTimes(1);
      const where = (lookup.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
      expect(where.orgId, name).toBe(ORG);
    }
  });

  // guards: BR-CASH-003
  it('пошук історії за назвою контрагента шукає контрагентів лише своєї організації, зі стелею', async () => {
    const { m, service } = setup();
    m.prisma.cashOperation.findMany.mockResolvedValueOnce([]);
    await service.listOperations(ORG, REG, 100, { q: 'Іваненко' });
    const args = m.prisma.counterparty.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      take: number;
    };
    expect(args.where.orgId).toBe(ORG);
    expect(args.take).toBe(500);
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
