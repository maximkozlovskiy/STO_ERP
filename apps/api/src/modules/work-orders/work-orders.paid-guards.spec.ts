/**
 * Сплачений наряд (рішення власника 2026-10-15): оплата з документа наряду робить «Сплачено» наряду
 * основою його життєвого циклу.
 *
 *   BR-WO-014 — наряд зі сплаченим > 0 не скасувати й не видалити; умова `paidAmount: 0` — у CAS;
 *   BR-WO-015 — сума наряду не нижча за сплачене (умовний запис тоталів); валюту сплаченого не
 *               змінити;
 *   BR-WO-016 — ручне «Оплачено» лише при повній оплаті; повністю сплачений наряд при переході у
 *               «Виконано» / «Виставлено» сам іде до «Оплачено» в тій самій транзакції.
 *
 * Наряд — таблиця в пам'яті (`memoryTable`): умовні записи (CAS) застосовують `where` по-справжньому,
 * тож «паралельна оплата між читанням і записом» — це зміна рядка, а не підмінена відповідь мока.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { WorkOrdersService } from './work-orders.service';
import { CalendarService } from '../calendar/calendar.service';
import { WorkOrderTotalsService } from './work-order-totals.service';
import { memoryTable, type MemRow } from '../cash/cash.spec-fixture';
import type { PrismaService } from '../../prisma/prisma.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const WO_ID = '22222222-2222-4222-8222-222222222222';
const UAH = 'uah-id';
const USD = 'usd-id';

function makeHarness(over: MemRow = {}) {
  const row: MemRow = {
    id: WO_ID,
    orgId: ORG,
    branchId: 'b',
    vehicleId: 'v',
    counterpartyId: 'c',
    number: 'НРД-1',
    status: 'IN_PROGRESS',
    priority: 'NORMAL',
    repairCategory: null,
    description: null,
    inMileage: null,
    outMileage: null,
    plannedAt: null,
    dueDate: null,
    completedAt: null,
    warrantyUntil: null,
    clientApproval: false,
    totalLabor: 1000,
    totalActualLabor: 1000,
    totalParts: 0,
    totalNet: 1000,
    totalAmount: 1000,
    totalVat: 0,
    paidAmount: 0,
    currencyId: UAH,
    documentDate: new Date('2026-10-08'),
    syncVersion: 0n,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    counterparty: { phone: null, email: null, firstName: null, lastName: null, companyName: 'ТОВ' },
    vehicle: { make: 'Toyota', model: 'Camry', licensePlate: 'AA0000AA' },
    branch: { name: 'Головна' },
    contract: null,
    currency: { code: 'UAH' },
    lift: null,
    ...over,
  };
  const workOrder = memoryTable([row]);
  // Prisma віддає ЗНІМОК рядка, а не посилання на нього: прочитане сервісом не змінюється
  // від його ж подальших записів (інакше «зі статусу» в подіях був би вже новий статус).
  const readRow = workOrder.findFirst.getMockImplementation()!;
  workOrder.findFirst.mockImplementation((args?: { where?: unknown }) =>
    readRow(args).then(r => (r ? { ...r } : r)),
  );
  const completionAct = memoryTable([]);
  const calendarSlot = memoryTable([]);
  const order: string[] = [];
  const db = { workOrder, completionAct, calendarSlot };
  const prisma: Record<string, unknown> = { ...db, lift: memoryTable([]) };
  const runTx = async (cb: (t: unknown) => unknown) => {
    order.push('tx-begin');
    const res = await cb(db);
    order.push('tx-commit');
    return res;
  };
  const begin = vi.fn(runTx);
  prisma.$transaction = begin;
  /** Змінити рядок «паралельно» — між читанням наряду і транзакцією. */
  const beforeTx = (change: () => void) =>
    begin.mockImplementationOnce((cb: (t: unknown) => unknown) => {
      change();
      return runTx(cb);
    });
  const stockEffects = {
    writeOffPartsAndCharge: vi.fn().mockResolvedValue(undefined),
    reserveParts: vi.fn().mockResolvedValue(undefined),
    releasePartReservations: vi.fn().mockResolvedValue(undefined),
    returnPartsAndCredit: vi.fn().mockResolvedValue(undefined),
    postFxIfSettled: vi.fn().mockResolvedValue(undefined),
  };
  const events = { emit: vi.fn() };
  const totals = { recalc: vi.fn().mockResolvedValue(undefined) };
  const service = new WorkOrdersService(
    prisma as unknown as PrismaService,
    stockEffects as never,
    null as never, // docNumbers
    null as never, // pdf
    { record: vi.fn().mockResolvedValue(undefined) } as never, // audit
    null as never, // settingsService
    null as never, // exchangeRates
    events as never,
    totals as never,
    null as never, // orgPrintInfo
    new CalendarService(prisma as unknown as PrismaService), // calendar (BR-WO-017)
  );
  const transitions = () =>
    events.emit.mock.calls
      .filter(c => c[0] === 'work-order.transitioned')
      .map(c => {
        const e = c[1] as { fromStatus: string; toStatus: string };
        return `${e.fromStatus}→${e.toStatus}`;
      });
  return { service, row, workOrder, prisma, beforeTx, stockEffects, events, transitions, order };
}

// ── BR-WO-014: сплачений наряд не скасувати й не видалити ──────────────────────────────────

describe('WorkOrdersService — сплачений наряд не скасувати (BR-WO-014)', () => {
  // guards: BR-WO-014
  it('скасування наряду з авансом → 400 «спершу сторнуйте оплату» ДО транзакції, статус той самий', async () => {
    const h = makeHarness({ status: 'APPROVED', paidAmount: 300 });

    await expect(h.service.transition(ORG, WO_ID, 'CANCELLED' as never, 'u')).rejects.toThrow(
      'Наряд має оплату 300.00 — спершу сторнуйте оплату, потім скасовуйте наряд',
    );

    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.row.status).toBe('APPROVED');
  });

  // Оплата прийшла між читанням наряду і записом статусу: швидка перевірка бачила 0, умовний
  // запис — уже ні. Помилка точна (про оплату), а не «статус змінився».
  // guards: BR-WO-014
  it('оплата між читанням і CAS → CAS (paidAmount: 0) не проходить → 400 про оплату, наряд не скасовано', async () => {
    const h = makeHarness({ status: 'ON_HOLD', paidAmount: 0 });
    h.beforeTx(() => {
      h.row.paidAmount = 150;
    });

    await expect(h.service.transition(ORG, WO_ID, 'CANCELLED' as never, 'u')).rejects.toThrow(
      'Наряд має оплату 150.00 — спершу сторнуйте оплату, потім скасовуйте наряд',
    );

    expect(h.row.status).toBe('ON_HOLD');
    expect(h.workOrder.updateMany.mock.calls[0]![0].where).toMatchObject({
      status: 'ON_HOLD',
      paidAmount: 0,
    });
    expect(h.stockEffects.releasePartReservations).not.toHaveBeenCalled();
  });

  // guards: BR-WO-014
  it('наряд без оплати скасовується як раніше', async () => {
    const h = makeHarness({ status: 'APPROVED', paidAmount: 0 });

    await h.service.transition(ORG, WO_ID, 'CANCELLED' as never, 'u');

    expect(h.row.status).toBe('CANCELLED');
  });

  // guards: BR-WO-014
  it('видалення наряду з оплатою → 400 «спершу сторнуйте оплату», deletedAt не ставиться', async () => {
    const h = makeHarness({ status: 'DRAFT', paidAmount: 50 });

    await expect(h.service.remove(ORG, WO_ID, 'u')).rejects.toThrow(
      'Наряд має оплату 50.00 — спершу сторнуйте оплату, потім видаляйте наряд',
    );

    expect(h.row.deletedAt).toBeNull();
    expect(h.workOrder.updateMany).not.toHaveBeenCalled();
  });

  // guards: BR-WO-014
  it('видалення: оплата між читанням і записом → CAS (paidAmount: 0) не проходить → 400 про оплату', async () => {
    const h = makeHarness({ status: 'DRAFT', paidAmount: 0 });
    h.workOrder.findFirst.mockImplementationOnce(() => {
      const snapshot = { ...h.row };
      h.row.paidAmount = 80;
      return Promise.resolve(snapshot);
    });

    await expect(h.service.remove(ORG, WO_ID, 'u')).rejects.toThrow(
      'Наряд має оплату 80.00 — спершу сторнуйте оплату, потім видаляйте наряд',
    );

    expect(h.row.deletedAt).toBeNull();
    expect(h.workOrder.updateMany.mock.calls[0]![0].where).toMatchObject({ paidAmount: 0 });
  });

  // guards: BR-WO-014
  it('чернетка без оплати видаляється', async () => {
    const h = makeHarness({ status: 'DRAFT', paidAmount: 0 });

    await h.service.remove(ORG, WO_ID, 'u');

    expect(h.row.deletedAt).toBeInstanceOf(Date);
  });
});

// ── BR-WO-016: «Оплачено» — лише за грошима ────────────────────────────────────────────────

describe('WorkOrdersService — «Оплачено» лише за грошима (BR-WO-016)', () => {
  // guards: BR-WO-016
  it('ручне «Оплачено» частково сплаченого наряду → 400 із залишком, статус той самий', async () => {
    const h = makeHarness({ status: 'INVOICED', paidAmount: 400 });

    await expect(h.service.transition(ORG, WO_ID, 'PAID' as never, 'u')).rejects.toThrow(
      'Наряд не сплачено повністю (залишок 600.00) — скористайтесь «Оплатити»',
    );

    expect(h.row.status).toBe('INVOICED');
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  // guards: BR-WO-016
  it('ручне «Оплачено» наряду на 0 грн → 400 (оплачувати нічого)', async () => {
    const h = makeHarness({ status: 'INVOICED', totalAmount: 0, paidAmount: 0 });

    await expect(h.service.transition(ORG, WO_ID, 'PAID' as never, 'u')).rejects.toThrow(
      BadRequestException,
    );
    expect(h.row.status).toBe('INVOICED');
  });

  // Сторно між перевіркою і записом: CAS тримає прочитані суми.
  // guards: BR-WO-016
  it('ручне «Оплачено» повністю сплаченого → проходить; CAS — на прочитаних сплаченому й сумі', async () => {
    const h = makeHarness({ status: 'INVOICED', paidAmount: 1000 });

    await h.service.transition(ORG, WO_ID, 'PAID' as never, 'u');

    expect(h.row.status).toBe('PAID');
    expect(h.workOrder.updateMany.mock.calls[0]![0].where).toMatchObject({
      status: 'INVOICED',
      paidAmount: 1000,
      totalAmount: 1000,
    });
  });

  // guards: BR-WO-016
  it('сторно між перевіркою і CAS (сплачено стало 600) → «Оплачено» не ставиться', async () => {
    const h = makeHarness({ status: 'INVOICED', paidAmount: 1000 });
    h.beforeTx(() => {
      h.row.paidAmount = 600;
    });

    await expect(h.service.transition(ORG, WO_ID, 'PAID' as never, 'u')).rejects.toThrow(
      BadRequestException,
    );
    expect(h.row.status).toBe('INVOICED');
  });

  // guards: BR-WO-016
  it('завершення наряду, сплаченого авансом повністю → «Виконано» → «Виставлено» → «Оплачено» в одній транзакції', async () => {
    const h = makeHarness({ status: 'IN_PROGRESS', paidAmount: 1000 });

    const dto = await h.service.transition(ORG, WO_ID, 'COMPLETED' as never, 'u');

    expect(h.row.status).toBe('PAID');
    // Відповідь — уже з кінцевим статусом (web бере статус із відповіді, не з кнопки).
    expect(dto.status).toBe('PAID');
    expect(h.transitions()).toEqual([
      'IN_PROGRESS→COMPLETED',
      'COMPLETED→INVOICED',
      'INVOICED→PAID',
    ]);
    // Борг нараховано в тій самій транзакції — курсова різниця (BR-PAY-022) теж тут.
    expect(h.stockEffects.writeOffPartsAndCharge).toHaveBeenCalledTimes(1);
    expect(h.stockEffects.postFxIfSettled).toHaveBeenCalledWith(ORG, WO_ID, 'u', expect.anything());
    // Усі три записи статусу — в одній транзакції: одна пара begin/commit.
    expect(h.order).toEqual(['tx-begin', 'tx-commit']);
  });

  // guards: BR-WO-016
  it('завершення частково сплаченого наряду → лишається «Виконано», курсової різниці немає', async () => {
    const h = makeHarness({ status: 'IN_PROGRESS', paidAmount: 999.99 });

    await h.service.transition(ORG, WO_ID, 'COMPLETED' as never, 'u');

    expect(h.row.status).toBe('COMPLETED');
    expect(h.transitions()).toEqual(['IN_PROGRESS→COMPLETED']);
    expect(h.stockEffects.postFxIfSettled).not.toHaveBeenCalled();
  });

  // guards: BR-WO-016
  it('ручне «Виставлено» повністю сплаченого наряду → далі до «Оплачено»', async () => {
    const h = makeHarness({ status: 'COMPLETED', paidAmount: 1000 });

    await h.service.transition(ORG, WO_ID, 'INVOICED' as never, 'u');

    expect(h.row.status).toBe('PAID');
    expect(h.transitions()).toEqual(['COMPLETED→INVOICED', 'INVOICED→PAID']);
  });
});

// ── BR-WO-015: валюта сплаченого наряду ────────────────────────────────────────────────────

describe('WorkOrdersService.update — валюта сплаченого наряду (BR-WO-015)', () => {
  // guards: BR-WO-015
  it('зміна валюти наряду з оплатою → 400, наряд не пишеться', async () => {
    const h = makeHarness({ status: 'IN_PROGRESS', paidAmount: 10 });

    await expect(h.service.update(ORG, WO_ID, { currencyId: USD })).rejects.toThrow(
      'Наряд уже має оплату — валюту змінити не можна',
    );
    expect(h.workOrder.update).not.toHaveBeenCalled();
    expect(h.row.currencyId).toBe(UAH);
  });

  // guards: BR-WO-015
  it('та сама валюта в запиті або наряд без оплати → правка проходить', async () => {
    const paid = makeHarness({ status: 'IN_PROGRESS', paidAmount: 10 });
    await paid.service.update(ORG, WO_ID, { currencyId: UAH, description: 'нове' });
    expect(paid.row.description).toBe('нове');

    const unpaid = makeHarness({ status: 'IN_PROGRESS', paidAmount: 0 });
    await unpaid.service.update(ORG, WO_ID, { currencyId: USD });
    expect(unpaid.row.currencyId).toBe(USD);
  });

  // Перевірка вище читає наряд без блокування: оплата, що прийшла між читанням і записом, інакше
  // лишила б «сплачено» в гривнях при доларовому наряді. Умова «нічого не сплачено» — у записі.
  // guards: BR-WO-015
  it('оплата між читанням і записом → зміна валюти не проходить (400), валюта та сама', async () => {
    const h = makeHarness({ status: 'IN_PROGRESS', paidAmount: 0 });
    const write = h.workOrder.update.getMockImplementation()!;
    h.workOrder.update.mockImplementationOnce((args: { where?: unknown; data: MemRow }) => {
      h.row.paidAmount = 300;
      return write(args);
    });

    await expect(h.service.update(ORG, WO_ID, { currencyId: USD })).rejects.toThrow(
      'Наряд уже має оплату — валюту змінити не можна',
    );
    expect(h.row.currencyId).toBe(UAH);
  });
});

// ── BR-WO-015: сума наряду не нижча за сплачене ────────────────────────────────────────────

describe('WorkOrderTotalsService.recalc — сума не нижча за сплачене (BR-WO-015)', () => {
  function makeTotals(paidAmount: number, lines: Array<{ amount: number; price: number }>) {
    const row: MemRow = {
      id: WO_ID,
      orgId: ORG,
      currencyId: null,
      documentDate: new Date('2026-10-08'),
      paidAmount,
      totalAmount: 1000,
    };
    const tx = {
      workOrder: memoryTable([row]),
      workOrderLine: {
        findMany: vi.fn().mockResolvedValue(
          lines.map(l => ({
            amount: l.amount,
            actualHours: null,
            normoHours: 1,
            price: l.price,
          })),
        ),
      },
      workOrderPart: { aggregate: vi.fn().mockResolvedValue({ _sum: { amount: 0 } }) },
    };
    const service = new WorkOrderTotalsService(
      { getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }) } as never,
      { resolveBaseConversion: vi.fn() } as never,
    );
    return { service, tx, row };
  }

  // guards: BR-WO-015
  it('рядки дали суму 300 при сплаченому 500 → 400 «спершу сторнуйте оплату», тотали не змінені', async () => {
    const h = makeTotals(500, [{ amount: 300, price: 300 }]);

    await expect(h.service.recalc(WO_ID, h.tx as never, ORG)).rejects.toThrow(
      'Сума наряду 300.00 стала б меншою за сплачене 500.00 — спершу сторнуйте оплату',
    );
    expect(h.row.totalAmount).toBe(1000);
  });

  // guards: BR-WO-015
  it('сума дорівнює сплаченому → пишеться; умова «сплачене ≤ сума» — у самому записі', async () => {
    const h = makeTotals(500, [{ amount: 500, price: 500 }]);

    await h.service.recalc(WO_ID, h.tx as never, ORG);

    expect(h.row.totalAmount).toBe(500);
    expect(h.tx.workOrder.updateMany.mock.calls[0]![0].where).toEqual({
      id: WO_ID,
      orgId: ORG,
      paidAmount: { lte: 500 },
    });
  });
});
