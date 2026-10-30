/**
 * Ролі за приводом (BR-CASH-021): OWNER, ADMIN, ACCOUNTANT проводять будь-яку ручну касову
 * операцію; RECEPTIONIST — лише «оплату контрагента» (`RECEPTIONIST_CASH_REASONS`), будь-який
 * інший привід для нього — 403.
 *
 * Маршрут `POST /cash-registers/:id/operations` пускає всі чотири ролі (метадані `@Roles`
 * стереже `cash/cash.access.spec.ts`), тож обмеження приймальні за приводом тримає саме сервіс.
 */
import { describe, it, expect } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { CASH_REASON_RULES, CASH_REASON_VALUES, RECEPTIONIST_CASH_REASONS } from '@sto/shared';
import {
  MISSING,
  USER,
  createOp,
  expectNothingMoved,
  makeDesk,
  validInput,
  type DeskUser,
} from './cash-desk.spec-fixture';

const MANUAL = CASH_REASON_VALUES.filter(r => CASH_REASON_RULES[r].manual);
const FORBIDDEN_FOR_RECEPTION = MANUAL.filter(r => !RECEPTIONIST_CASH_REASONS.includes(r));
const RECEPTIONIST: DeskUser = { id: USER, role: 'RECEPTIONIST' };

/** Операція дійшла до грошей хоч однією з гілок. */
const somethingMoved = (h: ReturnType<typeof makeDesk>): boolean =>
  h.cash.createOperation.mock.calls.length +
    h.payments.create.mock.calls.length +
    h.supplierPayments.createAndConfirm.mock.calls.length >
  0;

describe('CashDeskService.create — ролі за приводом', () => {
  // guards: BR-CASH-021
  it('приймальня проводить «оплату контрагента»', async () => {
    const h = makeDesk();
    await createOp(h, validInput('SALE_PAYMENT', { amount: 450.5 }), RECEPTIONIST);
    expect(h.payments.create).toHaveBeenCalledTimes(1);
    expect(h.payments.create.mock.calls[0][1]).toMatchObject({ amount: 450.5 });
  });

  // guards: BR-CASH-021
  it.each(FORBIDDEN_FOR_RECEPTION)(
    'приймальня з приводом %s → 403, нічого не проведено',
    async reason => {
      const h = makeDesk();
      const call = createOp(h, validInput(reason), RECEPTIONIST);
      await expect(call).rejects.toThrow(ForbiddenException);
      await expect(call).rejects.toThrow(/роль не дозволяє/);
      expectNothingMoved(h);
    },
  );

  // guards: BR-CASH-021
  it('заборонених для приймальні приводів — тринадцять із чотирнадцяти ручних', () => {
    expect(FORBIDDEN_FOR_RECEPTION).toHaveLength(13);
    expect(FORBIDDEN_FOR_RECEPTION).not.toContain('SALE_PAYMENT');
  });

  // guards: BR-CASH-021
  it.each(
    (['OWNER', 'ADMIN', 'ACCOUNTANT'] as const).flatMap(role =>
      MANUAL.map(r => [role, r] as const),
    ),
  )('%s проводить привід %s', async (role, reason) => {
    const h = makeDesk();
    await createOp(h, validInput(reason), { id: USER, role });
    expect(somethingMoved(h)).toBe(true);
  });

  // Заборонений привід відсікається ДО бази: інакше 404 «контрагента не знайдено» проти 403
  // казав би приймальні, чи існує запис із таким id.
  // guards: BR-CASH-021
  it('заборонений привід → 403 ще до читання каси, контрагента й підстави', async () => {
    const h = makeDesk();
    await expect(
      createOp(h, validInput('REFUND', { counterpartyId: MISSING }), RECEPTIONIST),
    ).rejects.toThrow(ForbiddenException);
    for (const table of [h.tables.cashRegister, h.tables.counterparty, h.tables.workOrder]) {
      expect(table.findFirst).not.toHaveBeenCalled();
    }
  });
});
