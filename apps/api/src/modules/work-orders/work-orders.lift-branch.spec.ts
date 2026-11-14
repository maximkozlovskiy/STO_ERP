/**
 * BR-WO-040 — філія наряду — філія його підйомника (рішення власника 2026-11-14, TECH-DEBT (б) №95).
 * Наряд, що отримує чи змінює підйомник (створення, зміна наряду, перенесення `reschedule`, зміна
 * запису наряду в календарі, «+ Слот» і перев'язка наряду без дат), у зоні іншої філії переходить у
 * цю філію в тій самій транзакції; дати перевіряються й запис ділиться її годинами й днями. Лише в
 * редагованому статусі, без оплат і рахунку — інакше 400 `err.workOrder.liftBranchLocked`, нічого
 * не змінено.
 *
 * Справжні WorkOrdersService + CalendarService над таблицями в пам'яті
 * (`work-orders.planning.spec-fixture.ts`: `where` виконується, `$transaction` відкочує таблиці).
 * «Зараз» — 20.05.2026 09:00 Києва. BRANCH — 08:00–18:00 щодня; BRANCH_2 (підйомник LIFT_B2) —
 * 09:00–18:00 пн–пт. 22.05.2026 — пт, 23.05 — сб, 25.05 — пн.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import {
  BRANCH,
  BRANCH_2,
  LIFT_1,
  LIFT_B2,
  NOW,
  ORG,
  WO_ID,
  createDto,
  kyiv,
  planningHarness,
  slotRow,
  woRow,
} from './work-orders.planning.spec-fixture';

const FRI = '2026-05-22';
const SAT = '2026-05-23';
const MON = '2026-05-25';
const iso = (d: string, hm: string) => kyiv(d, hm).toISOString();
const t = (d: unknown) => (d as Date).getTime();
const LOCKED = translateError('err.workOrder.liftBranchLocked', 'uk');

type Harness = ReturnType<typeof planningHarness>;
const wo = (h: Harness) => h.workOrder.rows.find(w => w.id === WO_ID)!;
/** Живі записи наряду: [підйомник, початок, кінець] за часом. */
const spans = (h: Harness) =>
  h
    .liveSlots()
    .sort((a, b) => t(a.startAt) - t(b.startAt))
    .map(s => [s.liftId, (s.startAt as Date).toISOString(), (s.endAt as Date).toISOString()]);

/** Наряд WO_ID (пт 10:00–12:00 на LIFT_1, філія BRANCH) з якорем у календарі. */
function planned(woOver: Record<string, unknown> = {}, invoices: Record<string, unknown>[] = []) {
  return planningHarness({
    workOrders: [
      woRow({
        liftId: LIFT_1,
        plannedAt: kyiv(FRI, '10:00'),
        dueDate: kyiv(FRI, '12:00'),
        ...woOver,
      }),
    ],
    slots: [slotRow('anchor', { startAt: kyiv(FRI, '10:00'), endAt: kyiv(FRI, '12:00') })],
    invoices,
  });
}

async function rejected(h: Harness, p: Promise<unknown>): Promise<Error> {
  const before = structuredClone([h.workOrder.rows, h.calendarSlot.rows]);
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(BadRequestException);
  expect(structuredClone([h.workOrder.rows, h.calendarSlot.rows])).toEqual(before);
  return e as Error;
}

describe('BR-WO-040 — філія наряду з підйомника', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-WO-040
  it('створення з підйомником іншої філії → філія підйомника, запис за її днями й годинами', async () => {
    const h = planningHarness({ workOrders: [] });

    const res = await h.service.create(
      ORG,
      createDto({ liftId: LIFT_B2, plannedAt: iso(FRI, '16:00'), dueDate: iso(MON, '11:00') }),
    );

    const created = h.workOrder.rows.find(w => w.id === res.id)!;
    expect(created.branchId).toBe(BRANCH_2);
    // Філія BRANCH (щодня 08–18) дала б ще сб і нд; BRANCH_2 — пт до 18:00, пн з 09:00.
    expect(
      h.calendarSlot.rows
        .filter(s => s.workOrderId === res.id && s.deletedAt === null)
        .map(s => [(s.startAt as Date).toISOString(), (s.endAt as Date).toISOString()])
        .sort(),
    ).toEqual([
      [iso(FRI, '16:00'), iso(FRI, '18:00')],
      [iso(MON, '09:00'), iso(MON, '11:00')],
    ]);
  });

  // guards: BR-WO-040, BR-WO-019
  it('створення: планові дати перевіряються днями філії підйомника → субота 400', async () => {
    const h = planningHarness({ workOrders: [] });

    const e = await h.service
      .create(
        ORG,
        createDto({ liftId: LIFT_B2, plannedAt: iso(SAT, '10:00'), dueDate: iso(SAT, '12:00') }),
      )
      .catch((x: unknown) => x);

    expect((e as Error).message).toBe(translateError('err.workOrder.plannedOnDayOff', 'uk'));
    expect(h.workOrder.rows).toHaveLength(0);
  });

  // guards: BR-WO-040
  it('створення з підйомником без зони — філія з форми', async () => {
    const h = planningHarness({ workOrders: [] });

    const res = await h.service.create(ORG, createDto({ liftId: LIFT_1 }));

    expect(h.workOrder.rows.find(w => w.id === res.id)!.branchId).toBe(BRANCH);
  });

  // guards: BR-WO-040
  it('зміна наряду: підйомник іншої філії → філія змінена, запис на новому підйомнику, журнал', async () => {
    const h = planned();

    await h.service.update(ORG, WO_ID, { liftId: LIFT_B2 }, 'user-1');

    expect(wo(h)).toMatchObject({ branchId: BRANCH_2, liftId: LIFT_B2 });
    expect(spans(h)).toEqual([[LIFT_B2, iso(FRI, '10:00'), iso(FRI, '12:00')]]);
    expect(h.audit.record).toHaveBeenCalledWith(
      ORG,
      'WorkOrder',
      WO_ID,
      'UPDATE',
      'user-1',
      expect.objectContaining({ branchId: BRANCH }),
      expect.objectContaining({ branchId: BRANCH_2, liftId: LIFT_B2 }),
    );
  });

  // guards: BR-WO-040, BR-WO-019
  it('незмінені дати перевіряються днями нової філії: наряд на суботу → 400, нічого не змінено', async () => {
    const h = planningHarness({
      workOrders: [
        woRow({ liftId: LIFT_1, plannedAt: kyiv(SAT, '10:00'), dueDate: kyiv(SAT, '12:00') }),
      ],
      slots: [slotRow('anchor', { startAt: kyiv(SAT, '10:00'), endAt: kyiv(SAT, '12:00') })],
    });

    const e = await rejected(h, h.service.update(ORG, WO_ID, { liftId: LIFT_B2 }));

    expect(e.message).toBe(translateError('err.workOrder.plannedOnDayOff', 'uk'));
  });

  // guards: BR-WO-040
  it.each([
    ['є оплата', { paidAmount: 100 }, []],
    [
      'є рахунок (чернетка)',
      {},
      [{ id: 'inv-1', orgId: ORG, workOrderId: WO_ID, status: 'DRAFT' }],
    ],
    ['є сплачений рахунок', {}, [{ id: 'inv-1', orgId: ORG, workOrderId: WO_ID, status: 'PAID' }]],
    ['статус «В роботі» (не редагований)', { status: 'IN_PROGRESS' }, []],
  ])('%s → 400 liftBranchLocked, наряд і запис без змін', async (_l, woOver, invoices) => {
    const h = planned(
      woOver,
      (invoices as Record<string, unknown>[]).map(i => ({ deletedAt: null, ...i })),
    );

    const e = await rejected(h, h.service.update(ORG, WO_ID, { liftId: LIFT_B2 }));

    expect(e.message).toBe(LOCKED);
  });

  // guards: BR-WO-040
  it('скасований рахунок і рахунок іншого наряду — філію змінити можна', async () => {
    const h = planned({}, [
      { id: 'inv-1', orgId: ORG, workOrderId: WO_ID, status: 'CANCELLED', deletedAt: null },
      { id: 'inv-2', orgId: ORG, workOrderId: 'other-wo', status: 'DRAFT', deletedAt: null },
    ]);

    await h.service.update(ORG, WO_ID, { liftId: LIFT_B2 });

    expect(wo(h).branchId).toBe(BRANCH_2);
  });

  // guards: BR-WO-040
  it.each([
    ['оплата', { paidAmount: 50 }],
    ['перехід «В роботу»', { status: 'IN_PROGRESS' }],
  ])(
    '%s між читанням і записом — 400, філія не змінена (умова в самому записі)',
    async (_l, change) => {
      const h = planned();
      const run = h.prisma.$transaction.getMockImplementation()!;
      h.prisma.$transaction.mockImplementationOnce((cb: (tx: unknown) => unknown) => {
        Object.assign(wo(h), change);
        return run(cb);
      });

      const e = await h.service
        .update(ORG, WO_ID, { liftId: LIFT_B2 })
        .catch((x: unknown) => x as Error);

      expect((e as Error).message).toBe(LOCKED);
      expect(wo(h)).toMatchObject({ branchId: BRANCH, liftId: LIFT_1 });
    },
  );

  // guards: BR-WO-040, BR-WO-023
  it('перенесення на рядок підйомника іншої філії → філія змінена; день — за днями нової філії', async () => {
    const h = planned();

    await h.service.reschedule(ORG, WO_ID, {
      slotId: 'anchor',
      startAt: iso(FRI, '10:00'),
      liftId: LIFT_B2,
    });
    expect(wo(h)).toMatchObject({ branchId: BRANCH_2, liftId: LIFT_B2 });

    const h2 = planned();
    const e = await rejected(
      h2,
      h2.service.reschedule(ORG, WO_ID, {
        slotId: 'anchor',
        startAt: iso(SAT, '10:00'),
        liftId: LIFT_B2,
      }),
    );
    expect(e.message).toBe(translateError('err.workOrder.plannedOnDayOff', 'uk'));
  });

  // guards: BR-WO-040, BR-WO-024
  it('зміна запису наряду (підйомник і кінець за закриття) → межі й поділ за годинами нової філії', async () => {
    const h = planned();

    await h.service.updateCalendarSlot(ORG, 'anchor', {
      liftId: LIFT_B2,
      startAt: iso(FRI, '16:00'),
      endAt: iso(FRI, '20:00'),
    });

    // Залишок 2 год за закриттям BRANCH_2 (18:00) — у пн з 09:00; BRANCH дала б сб 08–10.
    expect(wo(h)).toMatchObject({ branchId: BRANCH_2, liftId: LIFT_B2 });
    expect(t(wo(h).dueDate)).toBe(t(kyiv(MON, '11:00')));
    expect(wo(h).plannedHours).toBe(4);
    expect(spans(h)).toEqual([
      [LIFT_B2, iso(FRI, '16:00'), iso(FRI, '18:00')],
      [LIFT_B2, iso(MON, '09:00'), iso(MON, '11:00')],
    ]);
  });

  // guards: BR-WO-040, BR-WO-028
  it('«+ Слот» для наряду без дат на підйомнику іншої філії → наряд у цій філії', async () => {
    const h = planningHarness();

    await h.service.createCalendarSlot(ORG, {
      workOrderId: WO_ID,
      liftId: LIFT_B2,
      startAt: iso(FRI, '16:00'),
      endAt: iso(FRI, '20:00'),
    } as never);

    expect(wo(h)).toMatchObject({ branchId: BRANCH_2, liftId: LIFT_B2 });
    expect(t(wo(h).dueDate)).toBe(t(kyiv(MON, '11:00')));
  });

  // guards: BR-WO-040, BR-WO-028
  it('перев’язка запису без наряду на наряд без дат: підйомник запису іншої філії → наряд у ній', async () => {
    const h = planningHarness({
      slots: [
        slotRow('free', {
          workOrderId: null,
          liftId: LIFT_B2,
          startAt: kyiv(FRI, '10:00'),
          endAt: kyiv(FRI, '12:00'),
        }),
      ],
    });

    await h.service.updateCalendarSlot(ORG, 'free', { workOrderId: WO_ID });

    expect(wo(h)).toMatchObject({ branchId: BRANCH_2, liftId: LIFT_B2 });
    expect(spans(h)).toEqual([[LIFT_B2, iso(FRI, '10:00'), iso(FRI, '12:00')]]);
  });
});
