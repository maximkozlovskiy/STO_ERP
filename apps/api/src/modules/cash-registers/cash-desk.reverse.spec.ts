/**
 * Сторно касової операції (BR-CASH-023): НОВИЙ рядок каси протилежного напряму на ту саму суму, з
 * тим самим приводом, контрагентом, працівником, підставою й статтею, з `reversalOfId` = id
 * оригіналу, приміткою = причина і курсом оригіналу. Оригінал не змінюється. Відмови: не знайдено,
 * уже сторновано, сторно сторно, рядок зарплати чи банку. Усе — однією транзакцією.
 *
 * Що відкочується за приводом оригіналу (оплати, повернення) — `cash-desk.reverse-branches.spec.ts`.
 *
 * Написано зі специфікації ДО коду. Сигнатура з контракту плану 2026-10-14:
 *   CashDeskService.reverse(orgId, cashRegisterId, operationId, { reason }, actor: { id?; role })
 * Рядок пише лише `CashService.createOperation` (BR-CASH-001) — з `conversion` і `reversalOfId`.
 */
import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  CAT_EXPENSE,
  CLIENT,
  EMP,
  MISSING,
  ORG,
  OTHER_ORG,
  REG,
  USER,
  WO,
  makeDesk,
  newCashRows,
  reverseOp,
  seedOperation,
  type Desk,
} from './cash-desk.spec-fixture';
import type { MemRow } from '../cash/cash.spec-fixture';

const OTHER_REG = '23232323-2323-4323-8323-232323232323';

/** Вхід єдиного виклику createOperation (рядок сторно) і tx, з яким його покликано. */
function reversalCall(h: Desk): { input: MemRow; tx: unknown } {
  expect(h.cash.createOperation).toHaveBeenCalledTimes(1);
  const [orgId, input, tx] = h.cash.createOperation.mock.calls[0] as [string, MemRow, unknown];
  expect(orgId).toBe(ORG);
  return { input, tx };
}

/** Відмова не лишила слідів: журнал і проводки — як до виклику, наслідків не відкочено. */
function expectNothingReversed(h: Desk, seeded: number): void {
  expect(newCashRows(h, seeded)).toEqual([]);
  expect(h.settlementRows).toEqual([]);
  expect(h.payments.reverse).not.toHaveBeenCalled();
  expect(h.supplierPayments.reverse).not.toHaveBeenCalled();
}

describe('CashDeskService.reverse — рядок сторно', () => {
  // guards: BR-CASH-023
  it('внесення → новий рядок ВИДАЧІ на ту саму суму з копійками, той самий привід і каса; примітка = причина; reversalOfId = оригінал', async () => {
    const h = makeDesk();
    const orig = seedOperation(h, { direction: 'IN', reason: 'OWNER_IN', amount: 1250.75 });
    const seeded = h.cashRows.length;

    await reverseOp(h, orig.id as string, 'внесено двічі');

    const { input } = reversalCall(h);
    expect(input).toMatchObject({
      cashRegisterId: REG,
      direction: 'OUT',
      reason: 'OWNER_IN',
      notes: 'внесено двічі',
      reversalOfId: orig.id,
      createdBy: USER,
    });
    expect(Number(input.amount)).toBe(1250.75);
    // Рядок закомічено — і він рівно один.
    expect(newCashRows(h, seeded)).toHaveLength(1);
  });

  // guards: BR-CASH-023
  it('видача → новий рядок ВНЕСЕННЯ; примітка оригіналу НЕ переноситься — лише причина сторно', async () => {
    const h = makeDesk();
    const orig = seedOperation(h, {
      direction: 'OUT',
      reason: 'MANUAL_OUT',
      amount: 0.01,
      amountBase: 0.01,
      notes: 'на канцтовари',
    });
    await reverseOp(h, orig.id as string, 'видано помилково');
    const { input } = reversalCall(h);
    expect(input).toMatchObject({
      direction: 'IN',
      reason: 'MANUAL_OUT',
      notes: 'видано помилково',
    });
    expect(Number(input.amount)).toBe(0.01);
  });

  // guards: BR-CASH-023
  it.each<[string, MemRow]>([
    [
      'витрата зі статтею',
      { direction: 'OUT', reason: 'EXPENSE', expenseCategoryId: CAT_EXPENSE, amount: 3400.5 },
    ],
    [
      'видача під звіт працівникові',
      { direction: 'OUT', reason: 'ADVANCE_ISSUE', employeeId: EMP },
    ],
    ['повернення підзвітних', { direction: 'IN', reason: 'ADVANCE_RETURN', employeeId: EMP }],
  ])(
    '%s → контрагент, працівник, підстава й стаття в сторно — як в оригіналу',
    async (_n, over) => {
      const h = makeDesk();
      const orig = seedOperation(h, over);
      await reverseOp(h, orig.id as string);
      const { input } = reversalCall(h);
      expect(input.direction).toBe(over.direction === 'IN' ? 'OUT' : 'IN');
      expect(input.reason).toBe(orig.reason);
      expect(input.counterpartyId ?? null).toBe(orig.counterpartyId);
      expect(input.employeeId ?? null).toBe(orig.employeeId);
      expect(input.expenseCategoryId ?? null).toBe(orig.expenseCategoryId);
      expect(input.baseDocumentType ?? null).toBe(orig.baseDocumentType);
      expect(input.baseDocumentId ?? null).toBe(orig.baseDocumentId);
      expect(Number(input.amount)).toBe(Number(orig.amount));
    },
  );

  // guards: BR-CASH-023
  it('підстава і контрагент оригіналу (повернення клієнту за нарядом) переходять у сторно', async () => {
    const h = makeDesk();
    const orig = seedOperation(h, {
      direction: 'OUT',
      reason: 'REFUND',
      amount: 780.4,
      amountBase: 780.4,
      counterpartyId: CLIENT,
      baseDocumentType: 'WorkOrder',
      baseDocumentId: WO,
    });
    await reverseOp(h, orig.id as string);
    expect(reversalCall(h).input).toMatchObject({
      direction: 'IN',
      reason: 'REFUND',
      counterpartyId: CLIENT,
      baseDocumentType: 'WorkOrder',
      baseDocumentId: WO,
    });
  });

  // Валютна каса: сторно повертає ту саму базову суму, що записав оригінал (курс оригіналу), а
  // не перераховує за курсом на сьогодні — інакше гривневі звіти після «операція + сторно» ≠ 0.
  // guards: BR-CASH-023
  it('валютна операція → conversion сторно = курс і сума в базовій валюті ОРИГІНАЛУ', async () => {
    const h = makeDesk();
    h.tables.cashRegister.rows[0].currencyId = 'usd-id';
    const orig = seedOperation(h, {
      direction: 'IN',
      reason: 'OWNER_IN',
      amount: 30.5,
      amountBase: 1264.84,
      rateUsed: 41.47,
    });
    await reverseOp(h, orig.id as string);
    const conversion = reversalCall(h).input.conversion as {
      rateUsed: unknown;
      amountBase: unknown;
    };
    expect(conversion).toBeDefined();
    expect(Number(conversion.rateUsed)).toBe(41.47);
    expect(Number(conversion.amountBase)).toBe(1264.84);
  });

  // guards: BR-CASH-023
  it('базова валюта → conversion { 1, сума оригіналу }', async () => {
    const h = makeDesk();
    const orig = seedOperation(h, { amount: 999.99, amountBase: 999.99, rateUsed: 1 });
    await reverseOp(h, orig.id as string);
    const conversion = reversalCall(h).input.conversion as {
      rateUsed: unknown;
      amountBase: unknown;
    };
    expect(Number(conversion.rateUsed)).toBe(1);
    expect(Number(conversion.amountBase)).toBe(999.99);
  });

  // Журнал лише дописується (BR-CASH-002): сторно — новий рядок, оригінал лишається як був.
  // guards: BR-CASH-023, BR-CASH-002
  it('рядок оригіналу не змінюється: ні update, ні updateMany журналу, поля — як до сторно', async () => {
    const h = makeDesk();
    const orig = seedOperation(h, {
      direction: 'OUT',
      reason: 'EXPENSE',
      expenseCategoryId: CAT_EXPENSE,
    });
    const before = structuredClone(orig);
    await reverseOp(h, orig.id as string);
    expect(h.tables.cashOperation.update).not.toHaveBeenCalled();
    expect(h.tables.cashOperation.updateMany).not.toHaveBeenCalled();
    expect(h.cashRows.find(r => r.id === orig.id)).toEqual(before);
  });

  // guards: BR-CASH-023
  it('рядок пише ЄДИНИЙ писар у транзакції сторно: $transaction один, createOperation отримав його tx', async () => {
    const h = makeDesk();
    const orig = seedOperation(h);
    await reverseOp(h, orig.id as string);
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.isTx(reversalCall(h).tx)).toBe(true);
  });

  // Маршрут сторно — під ключем ідемпотентності: читання після коміту, що впало, зняло б
  // резервацію, і повтор отримав би 400 «уже сторновано» замість збереженої відповіді.
  // guards: BR-CASH-023
  it('відповідь сторно читається в його транзакції, а не після коміту', async () => {
    const h = makeDesk();
    const orig = seedOperation(h);
    const result = await reverseOp(h, orig.id as string);
    expect(h.cash.getHistoryRow).toHaveBeenCalledTimes(1);
    expect(h.isTx(h.cash.getHistoryRow.mock.calls[0][3])).toBe(true);
    expect(result).toMatchObject({ reversalOfId: orig.id });
  });

  // guards: BR-CASH-023
  it('автор сторно — користувач запиту, а не автор оригіналу', async () => {
    const h = makeDesk();
    const orig = seedOperation(h, { createdBy: 'aaaaaaaa-0000-4000-8000-00000000000a' });
    await reverseOp(h, orig.id as string, 'причина', { id: USER, role: 'ACCOUNTANT' });
    expect(reversalCall(h).input.createdBy).toBe(USER);
  });
});

describe('CashDeskService.reverse — що сторнувати не можна', () => {
  // guards: BR-CASH-023, BR-CASH-003
  it('операції немає → 404 «Касову операцію не знайдено», нічого не записано', async () => {
    const h = makeDesk();
    seedOperation(h);
    const seeded = h.cashRows.length;
    const call = reverseOp(h, MISSING);
    await expect(call).rejects.toThrow(NotFoundException);
    await expect(call).rejects.toThrow(/Касову операцію не знайдено/);
    expectNothingReversed(h, seeded);
  });

  // guards: BR-CASH-023, BR-CASH-003
  it('операція чужої організації → 404, хоч id і каса збігаються', async () => {
    const h = makeDesk();
    const foreign = seedOperation(h, { orgId: OTHER_ORG });
    const seeded = h.cashRows.length;
    await expect(reverseOp(h, foreign.id as string)).rejects.toThrow(NotFoundException);
    expectNothingReversed(h, seeded);
  });

  // Маршрут адресує операцію через касу (`/cash-registers/:id/operations/:operationId`): рядок
  // іншої каси через цю касу не сторнується — інакше сторно лягло б не в ту касу.
  // guards: BR-CASH-023
  it('операція іншої каси тієї ж організації → 404', async () => {
    const h = makeDesk();
    const elsewhere = seedOperation(h, { cashRegisterId: OTHER_REG });
    const seeded = h.cashRows.length;
    await expect(reverseOp(h, elsewhere.id as string)).rejects.toThrow(NotFoundException);
    expectNothingReversed(h, seeded);
  });

  // guards: BR-CASH-023
  it('сам рядок є сторно → 400 «Сторно не можна сторнувати»', async () => {
    const h = makeDesk();
    const orig = seedOperation(h);
    const storno = seedOperation(h, { direction: 'OUT', reversalOfId: orig.id, notes: 'помилка' });
    const seeded = h.cashRows.length;
    const call = reverseOp(h, storno.id as string);
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/Сторно не можна сторнувати/);
    expectNothingReversed(h, seeded);
  });

  // guards: BR-CASH-023
  it('операцію вже сторновано → 400 «Операцію вже сторновано», другого рядка немає', async () => {
    const h = makeDesk();
    const orig = seedOperation(h, { direction: 'OUT', reason: 'REFUND', counterpartyId: CLIENT });
    seedOperation(h, { direction: 'IN', reason: 'REFUND', reversalOfId: orig.id });
    const seeded = h.cashRows.length;
    const call = reverseOp(h, orig.id as string);
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/вже сторновано/);
    expectNothingReversed(h, seeded);
  });

  // Друге сторно разом із першим: обидва не бачать сторно при читанні, другого зупиняє
  // унікальний reversalOfId у CashService (400). Відкат наслідків за ним не має лишитись.
  // guards: BR-CASH-023
  it('гонка двох сторно: запис рядка відмовив «вже сторновано» → 400, проводки й відкату оплати немає', async () => {
    const h = makeDesk();
    const orig = seedOperation(h, {
      direction: 'OUT',
      reason: 'REFUND',
      counterpartyId: CLIENT,
      amount: 500,
      amountBase: 500,
    });
    const seeded = h.cashRows.length;
    h.cash.createOperation.mockRejectedValueOnce(
      new BadRequestException('Операцію вже сторновано'),
    );
    await expect(reverseOp(h, orig.id as string)).rejects.toThrow(BadRequestException);
    expectNothingReversed(h, seeded);
  });

  // guards: BR-CASH-023
  it.each([
    [
      'зарплатою',
      {
        direction: 'OUT',
        reason: 'PAYROLL',
        employeeId: EMP,
        documentType: 'PayrollPeriod',
        documentId: 'f0000001-0000-4000-8000-000000000001',
      },
    ],
    [
      'банком (готівка з банку)',
      {
        direction: 'IN',
        reason: 'BANK_WITHDRAWAL',
        documentType: 'BankTransaction',
        documentId: 'f0000002-0000-4000-8000-000000000002',
      },
    ],
    [
      'банком (здача в банк)',
      {
        direction: 'OUT',
        reason: 'BANK_DEPOSIT',
        documentType: 'BankTransaction',
        documentId: 'f0000003-0000-4000-8000-000000000003',
      },
    ],
  ])('рядок, створений %s → 400 «…скасуйте її там», нічого не записано', async (_n, over) => {
    const h = makeDesk();
    const orig = seedOperation(h, over);
    const seeded = h.cashRows.length;
    const call = reverseOp(h, orig.id as string);
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/скасуйте її там/);
    expectNothingReversed(h, seeded);
  });
});

describe('CashDeskService.reverse — одна транзакція: відмова будь-де → нічого', () => {
  // Правила каси діють і для сторно: видача сторно понад залишок, фіскальна каса без зміни —
  // відмовляє createOperation (BR-CASH-005, 006). Відкат наслідків тоді не починається.
  // guards: BR-CASH-023
  it('запис рядка сторно відмовив (немає залишку) → помилка як є, оплату не відкочено', async () => {
    const h = makeDesk();
    const orig = seedOperation(h, {
      direction: 'IN',
      reason: 'SALE_PAYMENT',
      counterpartyId: CLIENT,
      documentType: 'Payment',
      documentId: 'p0000001-0000-4000-8000-000000000001',
    });
    const seeded = h.cashRows.length;
    const noCash = new BadRequestException('Недостатньо коштів у касі');
    h.cash.createOperation.mockRejectedValueOnce(noCash);
    await expect(reverseOp(h, orig.id as string)).rejects.toBe(noCash);
    expectNothingReversed(h, seeded);
  });

  // guards: BR-CASH-023, BR-CASH-024
  it('відкат оплати відмовив (чек уже пробито) → рядка сторно в журналі немає, помилка піднята', async () => {
    const h = makeDesk();
    const orig = seedOperation(h, {
      direction: 'IN',
      reason: 'SALE_PAYMENT',
      counterpartyId: CLIENT,
      documentType: 'Payment',
      documentId: 'p0000002-0000-4000-8000-000000000002',
    });
    const seeded = h.cashRows.length;
    const fiscalDone = new BadRequestException('За цю оплату вже пробито фіскальний чек');
    h.payments.reverse.mockRejectedValueOnce(fiscalDone);
    await expect(reverseOp(h, orig.id as string)).rejects.toBe(fiscalDone);
    expect(newCashRows(h, seeded)).toEqual([]);
    expect(h.settlementRows).toEqual([]);
  });

  // guards: BR-CASH-023, BR-CASH-024
  it('відкат оплати постачальнику відмовив → рядка сторно немає', async () => {
    const h = makeDesk();
    const orig = seedOperation(h, {
      direction: 'OUT',
      reason: 'SUPPLIER_PAYMENT',
      counterpartyId: 'c0000002-0000-4000-8000-000000000002',
      documentType: 'SupplierPayment',
      documentId: 's0000001-0000-4000-8000-000000000001',
    });
    const seeded = h.cashRows.length;
    const boom = new BadRequestException('Оплата постачальнику не в базовій валюті');
    h.supplierPayments.reverse.mockRejectedValueOnce(boom);
    await expect(reverseOp(h, orig.id as string)).rejects.toBe(boom);
    expect(newCashRows(h, seeded)).toEqual([]);
    expect(h.settlementRows).toEqual([]);
  });

  // guards: BR-CASH-023, BR-CASH-025
  it('проводка сторно повернення відмовила → рядка сторно немає', async () => {
    const h = makeDesk();
    const orig = seedOperation(h, {
      direction: 'OUT',
      reason: 'REFUND',
      counterpartyId: CLIENT,
      amount: 780.4,
      amountBase: 780.4,
    });
    // Проводка оригіналу (REFUND_OUT на рядок) — сторно дзеркалить її курс.
    h.tables.settlementTransaction.rows.push({
      id: 'st-refund',
      orgId: ORG,
      settlementAccountId: 'acc-1',
      type: 'REFUND_OUT',
      amount: 780.4,
      amountBase: 780.4,
      rateUsed: 1,
      currencyId: null,
      documentType: 'CashOperation',
      documentId: orig.id,
    });
    const seeded = h.cashRows.length;
    const boom = new Error('settlement account locked');
    h.settlements.createTransaction.mockRejectedValueOnce(boom);
    await expect(reverseOp(h, orig.id as string)).rejects.toBe(boom);
    expect(newCashRows(h, seeded)).toEqual([]);
    expect(h.settlementRows).toEqual([]);
  });
});

describe('CashDeskService.reverse — доступ, причина, повтор і аудит (review 2026-10-14)', () => {
  // Маршрут має @Roles, але сервіс кличуть і не через HTTP — перевірка ролі своя.
  // guards: BR-CASH-023
  it.each(['RECEPTIONIST', 'STOREKEEPER', 'MECHANIC'])(
    '%s → 403, нічого не записано',
    async role => {
      const h = makeDesk();
      const orig = seedOperation(h);
      const seeded = h.cashRows.length;
      await expect(reverseOp(h, orig.id as string, 'помилка', { id: USER, role })).rejects.toThrow(
        ForbiddenException,
      );
      expectNothingReversed(h, seeded);
      expect(h.cash.createOperation).not.toHaveBeenCalled();
    },
  );

  // Повторює zod-схему: виклик не через HTTP схему не проходить.
  // guards: BR-CASH-023
  it.each([
    ['порожня', ''],
    ['самі пробіли', '  	 '],
  ])('причина %s → 400 «Вкажіть причину сторно», нічого не записано', async (_n, reason) => {
    const h = makeDesk();
    const orig = seedOperation(h);
    const seeded = h.cashRows.length;
    await expect(reverseOp(h, orig.id as string, reason)).rejects.toThrow(/причину сторно/);
    expectNothingReversed(h, seeded);
    expect(h.cash.createOperation).not.toHaveBeenCalled();
  });

  // Вже сторнований рядок відсікає читання, а не лише унікальний індекс: запису рядка
  // (з перевіркою залишку для видачі) навіть не пробуємо.
  // guards: BR-CASH-023
  it('рядок уже сторновано → відмова ДО спроби записати рядок', async () => {
    const h = makeDesk();
    const orig = seedOperation(h);
    seedOperation(h, { direction: 'OUT', reversalOfId: orig.id });
    await expect(reverseOp(h, orig.id as string)).rejects.toThrow(/вже сторновано/);
    expect(h.cash.createOperation).not.toHaveBeenCalled();
  });

  // guards: BR-CASH-023, BR-CASH-024
  it('сторно оплати пройшло → afterReversal з результатом сервісу оплат і автором, після коміту', async () => {
    const h = makeDesk();
    const orig = seedOperation(h, {
      reason: 'SALE_PAYMENT',
      counterpartyId: CLIENT,
      documentType: 'Payment',
      documentId: 'p0000003-0000-4000-8000-000000000003',
    });
    const seeded = h.cashRows.length;
    const result = {
      paymentId: orig.documentId,
      cashOperationId: 'x',
      reopenedWorkOrderId: null,
      loyalty: { earned: 0, deducted: 0 },
    };
    h.payments.reverse.mockResolvedValueOnce(result as never);
    h.payments.afterReversal.mockImplementationOnce(() => {
      // Викликано, коли рядок сторно вже в закоміченому журналі.
      expect(newCashRows(h, seeded)).toHaveLength(1);
    });
    await reverseOp(h, orig.id as string);
    expect(h.payments.afterReversal).toHaveBeenCalledTimes(1);
    expect(h.payments.afterReversal).toHaveBeenCalledWith(ORG, result, USER);
  });

  // Аудит рядка сторно — після коміту: відмова гілки відкату відкочує рядок, і подія аудиту
  // «створено рядок» про рядок, якого в журналі немає, лишилась би (наживо 2026-10-14).
  // guards: BR-CASH-023
  it('аудит рядка сторно: запис рядка — з deferAudit, аудит — після коміту', async () => {
    const h = makeDesk();
    const orig = seedOperation(h);
    await reverseOp(h, orig.id as string);
    expect(h.cash.createOperation.mock.calls[0][1]).toMatchObject({ deferAudit: true });
    expect(h.cash.recordCreated).toHaveBeenCalledTimes(1);
    expect(h.cash.recordCreated.mock.calls[0][2]).toBe(USER);
  });

  // guards: BR-CASH-023, BR-CASH-024
  it('відкат оплати відмовив → ні аудиту рядка сторно, ні afterReversal', async () => {
    const h = makeDesk();
    const orig = seedOperation(h, {
      reason: 'SALE_PAYMENT',
      counterpartyId: CLIENT,
      documentType: 'Payment',
      documentId: 'p0000004-0000-4000-8000-000000000004',
    });
    h.payments.reverse.mockRejectedValueOnce(new BadRequestException('чек пробито'));
    await expect(reverseOp(h, orig.id as string)).rejects.toThrow(BadRequestException);
    expect(h.cash.recordCreated).not.toHaveBeenCalled();
    expect(h.payments.afterReversal).not.toHaveBeenCalled();
  });
});
