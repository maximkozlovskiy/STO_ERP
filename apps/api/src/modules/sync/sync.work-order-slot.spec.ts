/**
 * BR-WO-024 — синхронізація з планшета (`sync push calendar_slots`): новий час чи підйомник
 * запису, що належить наряду, змінює наряд тим самим шляхом, що й `PATCH /calendar/slots/:id`
 * (`WorkOrdersService.updateCalendarSlot`). Відмова — конфлікт синхронізації з причиною в
 * `lastError`, ні наряд, ні записи не змінюються (як BR-WO-022, Bug #897). Примітка без зміни
 * часу — як раніше, записом.
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
  WO_ID,
  kyiv,
  planningHarness,
  slotRow,
  woRow,
} from '../work-orders/work-orders.planning.spec-fixture';

const D = '2026-05-22';
const t = (d: unknown) => (d as Date).getTime();

function harness(extraSlots: Record<string, unknown>[] = []) {
  const h = planningHarness({
    workOrders: [woRow({ liftId: LIFT_1, plannedAt: kyiv(D, '10:00'), dueDate: kyiv(D, '12:00') })],
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
});
