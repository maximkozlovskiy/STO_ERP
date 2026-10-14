/**
 * Що `CashService.createOperation` дописує в рядок каси за правилами «каси як місця оплат»:
 * документ-підставу (BR-CASH-020) і статтю, за якою закріплено привід (BR-CASH-022).
 *
 * Стаття за замовчуванням підставляється ЛИШЕ коли своєї не передано, і лише активна й
 * невидалена стаття цієї організації. Довідник статей тут — таблиця в пам'яті (`memoryTable`),
 * яка справді застосовує `where` сервісу: спек не знає, одним запитом сервіс відсіює вимкнену
 * статтю чи перевіряє `isActive` після читання, — і не мусить знати.
 */
import { describe, it, expect } from 'vitest';
import { ORG, REG, memoryTable, setup, type MemRow } from './cash.spec-fixture';

const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const WO = 'a0000001-0000-4000-8000-000000000001';
const PO = 'b0000001-0000-4000-8000-000000000001';

const category = (id: string, over: MemRow = {}): MemRow => ({
  id,
  orgId: ORG,
  name: id,
  type: 'EXPENSE',
  isActive: true,
  defaultReason: null,
  deletedAt: null,
  ...over,
});

/** Каса з довідником статей у пам'яті. */
function setupWithCategories(rows: MemRow[]) {
  const ctx = setup();
  Object.assign(ctx.m.prisma.expenseCategory, memoryTable(rows));
  return ctx;
}

const writtenCategory = (m: ReturnType<typeof setup>['m']): unknown =>
  m.prisma.cashOperation.create.mock.calls[0][0].data.expenseCategoryId;

describe('CashService.createOperation — документ-підстава в рядку каси', () => {
  // guards: BR-CASH-020
  it.each([
    ['WorkOrder', WO, 'IN', 'SALE_PAYMENT'],
    ['PurchaseOrder', PO, 'OUT', 'SUPPLIER_PAYMENT'],
  ] as const)(
    'підстава %s пишеться в baseDocumentType/baseDocumentId як передана',
    async (baseDocumentType, baseDocumentId, direction, reason) => {
      const { m, service } = setupWithCategories([]);
      await service.createOperation(ORG, {
        cashRegisterId: REG,
        direction,
        amount: 1250.75,
        reason,
        baseDocumentType,
        baseDocumentId,
      });
      expect(m.prisma.cashOperation.create.mock.calls[0][0].data).toMatchObject({
        baseDocumentType,
        baseDocumentId,
        amount: 1250.75,
      });
    },
  );

  // guards: BR-CASH-020
  it('підстава — не платіжний документ: обидві пари пишуться окремо й не змішуються', async () => {
    const { m, service } = setupWithCategories([]);
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 100,
      reason: 'SALE_PAYMENT',
      documentType: 'Payment',
      documentId: 'pay-1',
      baseDocumentType: 'WorkOrder',
      baseDocumentId: WO,
    });
    expect(m.prisma.cashOperation.create.mock.calls[0][0].data).toMatchObject({
      documentType: 'Payment',
      documentId: 'pay-1',
      baseDocumentType: 'WorkOrder',
      baseDocumentId: WO,
    });
  });

  // guards: BR-CASH-020
  it('підставу не передано → baseDocumentType і baseDocumentId пишуться як null', async () => {
    const { m, service } = setupWithCategories([]);
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 100,
      reason: 'MANUAL_IN',
    });
    const data = m.prisma.cashOperation.create.mock.calls[0][0].data;
    expect(data.baseDocumentType).toBeNull();
    expect(data.baseDocumentId).toBeNull();
  });
});

describe('CashService.createOperation — стаття за замовчуванням для приводу', () => {
  // guards: BR-CASH-022
  it.each([
    ['OUT', 'BANK_DEPOSIT', 'EXPENSE'],
    ['IN', 'OWNER_IN', 'INCOME'],
  ] as const)(
    '%s / %s без статті → підставляється активна стаття, за якою закріплено привід',
    async (direction, reason, type) => {
      const { m, service } = setupWithCategories([
        category('cat-other', { type }),
        category('cat-default', { type, defaultReason: reason }),
      ]);
      await service.createOperation(ORG, {
        cashRegisterId: REG,
        direction,
        amount: 640.55,
        reason,
      });
      expect(writtenCategory(m)).toBe('cat-default');
    },
  );

  // Готівка, знята з банківського рахунку, — переміщення власних грошей, а не дохід (BR-BANK-034):
  // рознесення виписки пише її приводом «Внесення» і статті мати не повинна.
  // guards: BR-CASH-022
  it('withoutCategory → рядок без статті, хоч за приводом закріплено активну статтю', async () => {
    const { m, service } = setupWithCategories([
      category('cat-default', { type: 'INCOME', defaultReason: 'MANUAL_IN' }),
    ]);
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 5000,
      reason: 'MANUAL_IN',
      withoutCategory: true,
    });
    expect(writtenCategory(m)).toBeNull();
  });

  // guards: BR-CASH-022
  it('свою статтю передано → лишається вона, стаття за замовчуванням не підміняє', async () => {
    const { m, service } = setupWithCategories([
      category('cat-own'),
      category('cat-default', { defaultReason: 'BANK_DEPOSIT' }),
    ]);
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'OUT',
      amount: 100,
      reason: 'BANK_DEPOSIT',
      expenseCategoryId: 'cat-own',
    });
    expect(writtenCategory(m)).toBe('cat-own');
  });

  // guards: BR-CASH-022
  it.each([
    ['вимкнена (isActive = false)', { isActive: false }],
    ['видалена (deletedAt задано)', { deletedAt: new Date('2026-10-01T10:00:00.000Z') }],
    ['чужої організації', { orgId: OTHER_ORG }],
    ['закріплена за ІНШИМ приводом', { defaultReason: 'OWNER_OUT' }],
  ])(
    'стаття за замовчуванням %s → не підставляється, операція проходить без статті',
    async (_n, over) => {
      const { m, service } = setupWithCategories([
        category('cat-default', { defaultReason: 'BANK_DEPOSIT', ...over }),
      ]);
      await service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'OUT',
        amount: 100,
        reason: 'BANK_DEPOSIT',
      });
      expect(m.prisma.cashOperation.create).toHaveBeenCalledTimes(1);
      expect(writtenCategory(m)).toBeNull();
    },
  );

  // guards: BR-CASH-022
  it('привід без закріпленої статті → операція без статті (як до правила)', async () => {
    const { m, service } = setupWithCategories([category('cat-plain')]);
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'OUT',
      amount: 100,
      reason: 'MANUAL_OUT',
    });
    expect(writtenCategory(m)).toBeNull();
  });

  // Такий стан через сервіс статей не створити (напрям приводу ↔ тип статті), але в базі він
  // можливий. Підставлена стаття мусить пройти ту саму перевірку напряму, що й обрана вручну
  // (BR-CASH-007): видача зі статтею оприбуткування в журнал не потрапляє — ні відмовою, ні
  // тихим пропуском статті правило не порушується, а записом такого рядка — порушується.
  // guards: BR-CASH-022, BR-CASH-007
  it('стаття за замовчуванням не того типу, що напрям → рядок із нею НЕ пишеться', async () => {
    const { m, service } = setupWithCategories([
      category('cat-wrong-type', { type: 'INCOME', defaultReason: 'BANK_DEPOSIT' }),
    ]);
    await service
      .createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'OUT',
        amount: 100,
        reason: 'BANK_DEPOSIT',
      })
      .catch(() => undefined);
    const written = m.prisma.cashOperation.create.mock.calls.map(
      c => (c[0] as { data: MemRow }).data.expenseCategoryId,
    );
    expect(written).not.toContain('cat-wrong-type');
  });

  // Статтю могли закріпити за приводом у ТІЙ САМІЙ транзакції викликача: читання кореневим
  // клієнтом її не побачило б.
  // guards: BR-CASH-022
  it('у зовнішній транзакції стаття за приводом читається ЇЇ клієнтом, не кореневим', async () => {
    const { service, m } = setupWithCategories([]);
    const outer = setup().m.prisma;
    Object.assign(
      outer.expenseCategory,
      memoryTable([category('cat-in-tx', { type: 'INCOME', defaultReason: 'OWNER_IN' })]),
    );

    await service.createOperation(
      ORG,
      { cashRegisterId: REG, direction: 'IN', amount: 10, reason: 'OWNER_IN' },
      outer as never,
    );

    expect(outer.cashOperation.create.mock.calls[0][0].data.expenseCategoryId).toBe('cat-in-tx');
    expect(m.prisma.expenseCategory.findFirst).not.toHaveBeenCalled();
  });

  // guards: BR-CASH-022
  it('операція, створена оплатою (свій tx, платіжний документ), теж отримує статтю за замовчуванням', async () => {
    const rows = [category('cat-sales', { type: 'INCOME', defaultReason: 'SALE_PAYMENT' })];
    const { service, m } = setupWithCategories(rows);
    const outer = setup().m.prisma;
    Object.assign(outer.expenseCategory, memoryTable(rows));

    await service.createOperation(
      ORG,
      {
        cashRegisterId: REG,
        direction: 'IN',
        amount: 3400.5,
        reason: 'SALE_PAYMENT',
        counterpartyId: 'cp-1',
        documentType: 'Payment',
        documentId: 'pay-1',
      },
      outer as never,
    );

    expect(outer.cashOperation.create).toHaveBeenCalledTimes(1);
    expect(outer.cashOperation.create.mock.calls[0][0].data).toMatchObject({
      expenseCategoryId: 'cat-sales',
      documentType: 'Payment',
      amount: 3400.5,
    });
    expect(m.prisma.cashOperation.create).not.toHaveBeenCalled();
  });
});
