/**
 * Документ-підстава касової операції (BR-CASH-020): необов'язковий; тип — лише той, який
 * дозволяє привід; тип і id — разом; підстава існує в організації, не видалена й належить
 * контрагентові операції. Підстава — НЕ платіжний документ рядка (`documentType/documentId`).
 *
 * Чотири приводи з підставою: наряд — для «оплати контрагента» й «повернення клієнту»,
 * замовлення постачальнику — для «оплати постачальнику» й «повернення від постачальника».
 */
import { describe, it, expect } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  CASH_REASON_RULES,
  CASH_REASON_VALUES,
  type CashBaseDocumentValue,
  type CashReasonValue,
} from '@sto/shared';
import {
  BOTH,
  MISSING,
  PO,
  PO_DELETED,
  PO_FOREIGN_ORG,
  PO_OF_SUPPLIER_2,
  WO,
  WO_DELETED,
  WO_FOREIGN_ORG,
  WO_OF_BOTH,
  WO_OF_CLIENT_2,
  createOp,
  expectNothingMoved,
  makeDesk,
  validInput,
} from './cash-desk.spec-fixture';

const MANUAL = CASH_REASON_VALUES.filter(r => CASH_REASON_RULES[r].manual);
const WITH_BASE = MANUAL.filter(r => CASH_REASON_RULES[r].baseDocument);
const WITHOUT_BASE = MANUAL.filter(r => !CASH_REASON_RULES[r].baseDocument);

/** Документи фікстури за типом підстави: свій, чужого контрагента, чужої організації, видалений. */
const DOCS: Record<
  CashBaseDocumentValue,
  { own: string; otherCounterparty: string; otherOrg: string; deleted: string }
> = {
  WorkOrder: {
    own: WO,
    otherCounterparty: WO_OF_CLIENT_2,
    otherOrg: WO_FOREIGN_ORG,
    deleted: WO_DELETED,
  },
  PurchaseOrder: {
    own: PO,
    otherCounterparty: PO_OF_SUPPLIER_2,
    otherOrg: PO_FOREIGN_ORG,
    deleted: PO_DELETED,
  },
};

const baseOf = (reason: CashReasonValue): CashBaseDocumentValue => {
  const type = CASH_REASON_RULES[reason].baseDocument;
  if (!type) throw new Error(`${reason}: привід без підстави`);
  return type;
};

describe('CashDeskService.create — документ-підстава: тип і повнота', () => {
  // guards: BR-CASH-020
  it('підстава є рівно в чотирьох приводів — цикли нижче не порожні', () => {
    expect(WITH_BASE).toEqual(['SALE_PAYMENT', 'SUPPLIER_REFUND_IN', 'REFUND', 'SUPPLIER_PAYMENT']);
  });

  // guards: BR-CASH-020
  it.each(WITH_BASE)('%s: тип підстави без id → 400, нічого не проведено', async reason => {
    const h = makeDesk();
    await expect(
      createOp(h, validInput(reason, { baseDocumentType: baseOf(reason) })),
    ).rejects.toThrow(BadRequestException);
    expectNothingMoved(h);
  });

  // guards: BR-CASH-020
  it.each(WITH_BASE)('%s: id підстави без типу → 400, нічого не проведено', async reason => {
    const h = makeDesk();
    await expect(
      createOp(h, validInput(reason, { baseDocumentId: DOCS[baseOf(reason)].own })),
    ).rejects.toThrow(BadRequestException);
    expectNothingMoved(h);
  });

  // guards: BR-CASH-020
  it.each(WITH_BASE)(
    '%s: підстава НЕ ТОГО типу (існуючий документ іншого виду) → 400 «не може бути підставою»',
    async reason => {
      const h = makeDesk();
      const wrong: CashBaseDocumentValue =
        baseOf(reason) === 'WorkOrder' ? 'PurchaseOrder' : 'WorkOrder';
      const call = createOp(
        h,
        validInput(reason, { baseDocumentType: wrong, baseDocumentId: DOCS[wrong].own }),
      );
      await expect(call).rejects.toThrow(BadRequestException);
      await expect(call).rejects.toThrow(/не може бути підставою/);
      expectNothingMoved(h);
    },
  );

  // guards: BR-CASH-020
  it.each(WITHOUT_BASE)(
    '%s: привід без підстави в таблиці не приймає жодної → 400',
    async reason => {
      const h = makeDesk();
      const call = createOp(
        h,
        validInput(reason, { baseDocumentType: 'WorkOrder', baseDocumentId: WO }),
      );
      await expect(call).rejects.toThrow(BadRequestException);
      await expect(call).rejects.toThrow(/не може бути підставою/);
      expectNothingMoved(h);
    },
  );
});

describe('CashDeskService.create — документ-підстава: існування й належність', () => {
  // guards: BR-CASH-020
  it.each(WITH_BASE)('%s: підстави з таким id немає → 404', async reason => {
    const h = makeDesk();
    const call = createOp(
      h,
      validInput(reason, { baseDocumentType: baseOf(reason), baseDocumentId: MISSING }),
    );
    await expect(call).rejects.toThrow(NotFoundException);
    await expect(call).rejects.toThrow(/Документ-підставу не знайдено/);
    expectNothingMoved(h);
  });

  // guards: BR-CASH-020, BR-CASH-003
  it.each(WITH_BASE)('%s: підстава з ЧУЖОЇ організації → 404', async reason => {
    const h = makeDesk();
    const type = baseOf(reason);
    const call = createOp(
      h,
      validInput(reason, { baseDocumentType: type, baseDocumentId: DOCS[type].otherOrg }),
    );
    await expect(call).rejects.toThrow(NotFoundException);
    await expect(call).rejects.toThrow(/Документ-підставу не знайдено/);
    expectNothingMoved(h);
  });

  // guards: BR-CASH-020
  it.each(WITH_BASE)('%s: ВИДАЛЕНА підстава → 404', async reason => {
    const h = makeDesk();
    const type = baseOf(reason);
    const call = createOp(
      h,
      validInput(reason, { baseDocumentType: type, baseDocumentId: DOCS[type].deleted }),
    );
    await expect(call).rejects.toThrow(NotFoundException);
    await expect(call).rejects.toThrow(/Документ-підставу не знайдено/);
    expectNothingMoved(h);
  });

  // guards: BR-CASH-020
  it.each(WITH_BASE)(
    '%s: підстава ІНШОГО контрагента → 400 «належить іншому контрагентові»',
    async reason => {
      const h = makeDesk();
      const type = baseOf(reason);
      const call = createOp(
        h,
        validInput(reason, {
          baseDocumentType: type,
          baseDocumentId: DOCS[type].otherCounterparty,
        }),
      );
      await expect(call).rejects.toThrow(BadRequestException);
      await expect(call).rejects.toThrow(/належить іншому контрагентові/);
      expectNothingMoved(h);
    },
  );

  // guards: BR-CASH-020
  it('контрагент «обидва» зі СВОЇМ нарядом проходить, із нарядом іншого клієнта — 400', async () => {
    const ok = makeDesk();
    await createOp(
      ok,
      validInput('REFUND', {
        counterpartyId: BOTH,
        baseDocumentType: 'WorkOrder',
        baseDocumentId: WO_OF_BOTH,
      }),
    );
    expect(ok.cash.createOperation).toHaveBeenCalledTimes(1);

    const bad = makeDesk();
    await expect(
      createOp(
        bad,
        validInput('REFUND', {
          counterpartyId: BOTH,
          baseDocumentType: 'WorkOrder',
          baseDocumentId: WO,
        }),
      ),
    ).rejects.toThrow(/належить іншому контрагентові/);
    expectNothingMoved(bad);
  });
});

describe('CashDeskService.create — підстава в рядку каси', () => {
  // guards: BR-CASH-020
  it.each([
    ['REFUND', 'WorkOrder', WO],
    ['SUPPLIER_REFUND_IN', 'PurchaseOrder', PO],
  ] as const)(
    '%s: підстава пишеться в baseDocument*, а не в платіжний документ рядка',
    async (reason, type, id) => {
      const h = makeDesk();
      await createOp(h, validInput(reason, { baseDocumentType: type, baseDocumentId: id }));
      const input = h.cash.createOperation.mock.calls[0][1];
      expect(input).toMatchObject({ baseDocumentType: type, baseDocumentId: id });
      expect(input.documentType ?? null).not.toBe(type);
      expect(input.documentId ?? null).not.toBe(id);
    },
  );

  // guards: BR-CASH-020
  it.each(['REFUND', 'SUPPLIER_REFUND_IN'] as const)(
    '%s без підстави проходить: підстава необов’язкова, у рядку її немає',
    async reason => {
      const h = makeDesk();
      await createOp(h, validInput(reason));
      const input = h.cash.createOperation.mock.calls[0][1];
      expect(input.baseDocumentType ?? null).toBeNull();
      expect(input.baseDocumentId ?? null).toBeNull();
    },
  );
});
