/**
 * BR-WO-024 — синхронізація з планшета (`sync push calendar_slots`): новий час чи підйомник
 * запису, що належить наряду, змінює наряд тим самим шляхом, що й `PATCH /calendar/slots/:id`
 * (`WorkOrdersService.updateCalendarSlot`). Відмова — конфлікт синхронізації з причиною в
 * `lastError`, ні наряд, ні записи не змінюються (як BR-WO-022, Bug #897). Примітка без зміни
 * часу — як раніше, записом. Час лише в редагованих статусах наряду (BR-WO-027), інший наряд —
 * перев'язка (BR-WO-028), видалення запису наряду стирає дати наряду (BR-WO-026).
 *
 * Справжні SyncService, WorkOrdersService і CalendarService над таблицями в пам'яті
 * (`work-orders.planning.spec-fixture.ts`): `where` виконується, `$transaction` відкочує таблиці.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { translateError, type SyncRecord } from '@sto/shared';
import { SyncService } from './sync.service';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  LIFT_1,
  LIFT_2,
  NOW,
  ORG,
  OTHER_WO,
  WO_ID,
  kyiv,
  planningHarness,
  slotRow,
  woRow,
} from '../work-orders/work-orders.planning.spec-fixture';

const D = '2026-05-22';
const t = (d: unknown) => (d as Date).getTime();

function harness(
  extraSlots: Record<string, unknown>[] = [],
  over: { wo?: Record<string, unknown>; other?: Record<string, unknown> } = {},
) {
  const h = planningHarness({
    workOrders: [
      woRow({
        liftId: LIFT_1,
        plannedAt: kyiv(D, '10:00'),
        dueDate: kyiv(D, '12:00'),
        ...over.wo,
      }),
      woRow({ id: OTHER_WO, number: 'НРД-9', ...over.other }),
    ],
    slots: [slotRow('anchor', { syncVersion: 1n }), ...(extraSlots as never[])],
  });
  const syncJob = { create: vi.fn().mockResolvedValue({}) };
  const sync = new SyncService({ ...h.prisma, syncJob } as unknown as PrismaService, h.service);
  const lastErrors = () =>
    syncJob.create.mock.calls.map(c => (c[0] as { data: { lastError: string } }).data.lastError);
  const wo = () => h.workOrder.rows.find(w => w.id === WO_ID)!;
  return { ...h, sync, lastErrors, wo };
}

const update = (payload: Record<string, unknown>): SyncRecord => ({
  table: 'calendar_slots',
  id: 'anchor',
  operation: 'UPDATE',
  syncVersion: 5,
  payload,
});

describe('SyncService.push calendar_slots — запис наряду через наряд (BR-WO-024)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-WO-024
  it('новий кінець і підйомник запису наряду → прийнято, дати й підйомник наряду змінено', async () => {
    const h = harness();

    const res = await h.sync.push(
      ORG,
      [
        update({
          startAt: kyiv(D, '10:00').toISOString(),
          endAt: kyiv(D, '13:00').toISOString(),
          liftId: LIFT_2,
          workOrderId: WO_ID,
        }),
      ],
      'ADMIN',
    );

    expect(res).toEqual({ accepted: 1, conflicts: 0 });
    expect(t(h.wo().plannedAt)).toBe(t(kyiv(D, '10:00')));
    expect(t(h.wo().dueDate)).toBe(t(kyiv(D, '13:00')));
    expect(h.wo().liftId).toBe(LIFT_2);
    expect(h.liveSlots()).toEqual([
      expect.objectContaining({ id: 'anchor', liftId: LIFT_2, endAt: kyiv(D, '13:00') }),
    ]);
  });

  // guards: BR-WO-024, BR-CAL-005
  it('новий час на зайнятому підйомнику → конфлікт із причиною, наряд і записи не змінено', async () => {
    const h = harness([
      slotRow('busy', {
        workOrderId: null,
        startAt: kyiv(D, '12:00'),
        endAt: kyiv(D, '13:00'),
      }),
    ]);
    const before = structuredClone([h.workOrder.rows, h.calendarSlot.rows]);

    const res = await h.sync.push(
      ORG,
      [update({ endAt: kyiv(D, '12:30').toISOString() })],
      'ADMIN',
    );

    expect(res).toEqual({ accepted: 0, conflicts: 1 });
    expect(h.lastErrors()).toEqual([translateError('err.calendar.liftBusy', 'uk')]);
    expect([h.workOrder.rows, h.calendarSlot.rows]).toEqual(before);
  });

  // guards: BR-WO-024
  it('у минуле → конфлікт «в минулому» (BR-WO-019), без змін', async () => {
    const h = harness();

    const res = await h.sync.push(
      ORG,
      [update({ startAt: kyiv('2026-05-20', '08:00').toISOString() })],
      'ADMIN',
    );

    expect(res.conflicts).toBe(1);
    expect(h.lastErrors()).toEqual([translateError('err.workOrder.plannedInPast', 'uk')]);
    expect(t(h.wo().plannedAt)).toBe(t(kyiv(D, '10:00')));
  });

  // guards: BR-WO-024
  it('лише примітка (час і підйомник ті самі) → запис змінено сам, наряд не чіпається', async () => {
    const h = harness();
    const before = structuredClone(h.wo());

    const res = await h.sync.push(
      ORG,
      [
        update({
          startAt: kyiv(D, '10:00').toISOString(),
          endAt: kyiv(D, '12:00').toISOString(),
          liftId: LIFT_1,
          notes: 'З планшета',
        }),
      ],
      'ADMIN',
    );

    expect(res).toEqual({ accepted: 1, conflicts: 0 });
    expect(h.wo()).toEqual(before);
    expect(h.liveSlots()[0]).toMatchObject({ notes: 'З планшета' });
  });

  // guards: BR-WO-027
  it('новий час запису наряду «В роботі» → конфлікт із причиною, без змін', async () => {
    const h = harness([], { wo: { status: 'IN_PROGRESS' } });
    const before = structuredClone([h.workOrder.rows, h.calendarSlot.rows]);

    const res = await h.sync.push(
      ORG,
      [update({ endAt: kyiv(D, '13:00').toISOString() })],
      'ADMIN',
    );

    expect(res).toEqual({ accepted: 0, conflicts: 1 });
    expect(h.lastErrors()).toEqual([translateError('err.calendar.workOrderSlotLocked', 'uk')]);
    expect([h.workOrder.rows, h.calendarSlot.rows]).toEqual(before);
  });

  // guards: BR-WO-028
  it('інший наряд з датами → запис на його дати й підйомник, попередній наряд без дат', async () => {
    const h = harness([], {
      other: { liftId: LIFT_2, plannedAt: kyiv(D, '14:00'), dueDate: kyiv(D, '16:00') },
    });

    const res = await h.sync.push(ORG, [update({ workOrderId: OTHER_WO })], 'ADMIN');

    expect(res).toEqual({ accepted: 1, conflicts: 0 });
    expect(h.liveSlots(OTHER_WO)).toEqual([
      expect.objectContaining({ id: 'anchor', liftId: LIFT_2, startAt: kyiv(D, '14:00') }),
    ]);
    expect(h.wo()).toMatchObject({ plannedAt: null, dueDate: null });
  });

  // guards: BR-WO-028
  it("перев'язка з наряду «В роботі» → конфлікт із причиною, без змін", async () => {
    const h = harness([], { wo: { status: 'IN_PROGRESS' } });
    const before = structuredClone([h.workOrder.rows, h.calendarSlot.rows]);

    const res = await h.sync.push(ORG, [update({ workOrderId: OTHER_WO })], 'ADMIN');

    expect(res).toEqual({ accepted: 0, conflicts: 1 });
    expect(h.lastErrors()).toEqual([translateError('err.calendar.workOrderRelinkLocked', 'uk')]);
    expect([h.workOrder.rows, h.calendarSlot.rows]).toEqual(before);
  });
});

describe('SyncService.push calendar_slots — видалення запису наряду (BR-WO-026)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const remove = (syncVersion: number): SyncRecord => ({
    table: 'calendar_slots',
    id: 'anchor',
    operation: 'DELETE',
    syncVersion,
    payload: {},
  });

  // guards: BR-WO-026
  it('видалення з планшета (новіша версія) → ланцюжок видалено, дати наряду стерто', async () => {
    const h = harness([
      slotRow('cont', {
        parentSlotId: 'anchor',
        startAt: kyiv('2026-05-23', '08:00'),
        endAt: kyiv('2026-05-23', '09:00'),
      }),
    ]);

    const res = await h.sync.push(ORG, [remove(5)], 'ADMIN');

    expect(res).toEqual({ accepted: 1, conflicts: 0 });
    expect(h.liveSlots()).toEqual([]);
    expect(h.wo()).toMatchObject({ plannedAt: null, dueDate: null });
  });

  // guards: BR-WO-026
  it('застаріла версія видалення → прийнято без змін (LWW), дати наряду лишаються', async () => {
    const h = harness();
    h.calendarSlot.rows[0].syncVersion = 9n;

    const res = await h.sync.push(ORG, [remove(5)], 'ADMIN');

    expect(res).toEqual({ accepted: 1, conflicts: 0 });
    expect(h.liveSlots().map(s => s.id)).toEqual(['anchor']);
    expect(t(h.wo().plannedAt)).toBe(t(kyiv(D, '10:00')));
  });

  // Рішення власника 2026-10-19: лише в WO_EDITABLE_STATUSES.
  // guards: BR-WO-026
  it('видалення запису наряду «В роботі» → конфлікт із причиною, запис і дати наряду цілі', async () => {
    const h = harness([], { wo: { status: 'IN_PROGRESS' } });
    const before = structuredClone([h.workOrder.rows, h.calendarSlot.rows]);

    const res = await h.sync.push(ORG, [remove(5)], 'ADMIN');

    expect(res).toEqual({ accepted: 0, conflicts: 1 });
    expect(h.lastErrors()).toEqual([
      translateError('err.calendar.workOrderSlotDeleteLocked', 'uk'),
    ]);
    expect([h.workOrder.rows, h.calendarSlot.rows]).toEqual(before);
  });
});

describe('SyncService.push calendar_slots — новий запис із нарядом (BR-WO-028, Bug #905)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const create = (workOrderId: string): SyncRecord => ({
    table: 'calendar_slots',
    id: 'tablet-1',
    operation: 'INSERT',
    syncVersion: 1,
    payload: {
      workOrderId,
      liftId: LIFT_2,
      startAt: kyiv('2026-05-23', '13:00').toISOString(),
      endAt: kyiv('2026-05-23', '15:00').toISOString(),
    },
  });

  /** Таблиця в пам'яті зберігає рядок як є; Prisma перетворює ISO-рядки дат на `Date`. */
  function withDates(h: ReturnType<typeof harness>) {
    const create = h.prisma.calendarSlot.create;
    h.prisma.calendarSlot.create = ((args: { data: Record<string, unknown> }) => {
      const data = { ...args.data };
      for (const k of ['startAt', 'endAt'])
        if (typeof data[k] === 'string') data[k] = new Date(data[k] as string);
      return create({ ...args, data });
    }) as typeof create;
    return h;
  }

  // guards: BR-WO-028
  it('наряд без дат → запис планшета (той самий id) став записом наряду, наряд отримав його дати', async () => {
    const h = withDates(harness());

    const res = await h.sync.push(ORG, [create(OTHER_WO)], 'ADMIN');

    expect(res).toEqual({ accepted: 1, conflicts: 0 });
    expect(h.liveSlots(OTHER_WO)).toEqual([
      expect.objectContaining({ id: 'tablet-1', liftId: LIFT_2 }),
    ]);
    const other = h.workOrder.rows.find(w => w.id === OTHER_WO)!;
    expect(other).toMatchObject({ liftId: LIFT_2 });
    expect(t(other.plannedAt)).toBe(t(kyiv('2026-05-23', '13:00')));
  });

  // guards: BR-WO-028, BR-WO-027
  it('наряд «В роботі» → конфлікт із причиною, створений запис позначено видаленим, наряд без змін', async () => {
    const h = withDates(harness([], { other: { status: 'IN_PROGRESS' } }));

    const res = await h.sync.push(ORG, [create(OTHER_WO)], 'ADMIN');

    expect(res).toEqual({ accepted: 0, conflicts: 1 });
    expect(h.lastErrors()).toEqual([translateError('err.calendar.workOrderRelinkLocked', 'uk')]);
    expect(h.calendarSlot.rows.find(s => s.id === 'tablet-1')).toMatchObject({
      deletedAt: expect.any(Date),
    });
    expect(h.workOrder.rows.find(w => w.id === OTHER_WO)).toMatchObject({ plannedAt: null });
  });
});
