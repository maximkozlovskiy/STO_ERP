/**
 * BR-WO-020 — наряд сам потрапляє в календар (рішення власника 2026-10-16). Наряд із плановими
 * початком і завершенням має запис календаря на своєму підйомнику (або «Без підйомника»): сервер
 * у тій самій транзакції, що й збереження наряду, створює запис, переносить його при зміні дат чи
 * підйомника (механік запису зберігається; на підйомнику, за яким він не закріплений, —
 * знімається за BR-CAL-012) і позначає видаленим, коли дати стерто. Розбиття на дні та перевірка
 * зайнятості — як для запису календаря; зайнятий підйомник чи механік — 400, наряд не змінюється.
 * Один запис на наряд.
 *
 * Справжні WorkOrdersService + CalendarService над таблицями в пам'яті
 * (`work-orders.planning.spec-fixture.ts`). Правило — docs/objects/work-order.md, BR-WO-020.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import {
  LIFT_1,
  LIFT_2,
  MECH_1,
  MECH_BOTH,
  NOW,
  ORG,
  OTHER_ORG,
  OTHER_WO,
  WO_ID,
  createDto,
  kyiv,
  planningHarness,
  slotRow,
  woRow,
} from './work-orders.planning.spec-fixture';

const D = '2026-05-22';
const D2 = '2026-05-23';
const LIFT_BUSY = translateError('err.calendar.liftBusy', 'uk');
const LIFT_BUSY_NEXT = translateError('err.calendar.liftBusyNextDay', 'uk');
const EMPLOYEE_BUSY = translateError('err.calendar.employeeBusy', 'uk');

const t = (d: unknown) => (d as Date).getTime();

async function rejection(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BadRequestException);
  return err as Error;
}

/** Наряд WO_ID із датами D 10:00–12:00 на LIFT_1 і його якір у календарі. */
function plannedWo(
  slotOver: Record<string, unknown> = {},
  extraSlots: Record<string, unknown>[] = [],
) {
  return planningHarness({
    workOrders: [
      woRow({
        liftId: LIFT_1,
        plannedAt: kyiv(D, '10:00'),
        dueDate: kyiv(D, '12:00'),
      }),
      woRow({ id: OTHER_WO, number: 'НРД-9' }),
    ],
    slots: [slotRow('anchor', slotOver), ...(extraSlots as never[])],
  });
}

describe('WorkOrdersService — запис календаря наряду (BR-WO-020)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('створення наряду', () => {
    // guards: BR-WO-020
    it('з плановими початком, завершенням і підйомником → рівно один запис у транзакції', async () => {
      const h = planningHarness({ workOrders: [] });
      const wo = await h.service.create(
        ORG,
        createDto({
          liftId: LIFT_1,
          plannedAt: kyiv(D, '10:00').toISOString(),
          dueDate: kyiv(D, '12:00').toISOString(),
        }),
      );
      expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
      const live = h.liveSlots(wo.id);
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({
        orgId: ORG,
        liftId: LIFT_1,
        workOrderId: wo.id,
        employeeId: null,
        parentSlotId: null,
        status: 'BOOKED',
        type: 'WORK',
      });
      expect(t(live[0]!.startAt)).toBe(t(kyiv(D, '10:00')));
      expect(t(live[0]!.endAt)).toBe(t(kyiv(D, '12:00')));
    });

    // guards: BR-WO-020
    it('без підйомника → запис «Без підйомника» (liftId = null)', async () => {
      const h = planningHarness({ workOrders: [] });
      const wo = await h.service.create(
        ORG,
        createDto({
          plannedAt: kyiv(D, '10:00').toISOString(),
          dueDate: kyiv(D, '12:00').toISOString(),
        }),
      );
      expect(h.liveSlots(wo.id)).toEqual([expect.objectContaining({ liftId: null })]);
    });

    // guards: BR-WO-020
    it.each([
      ['лише початок', { plannedAt: kyiv(D, '10:00').toISOString() }],
      ['лише завершення', { dueDate: kyiv(D, '12:00').toISOString() }],
      ['без дат', {}],
    ])('%s → запису немає і транзакції немає', async (_l, dates) => {
      const h = planningHarness({ workOrders: [] });
      await h.service.create(ORG, createDto({ liftId: LIFT_1, ...dates }));
      expect(h.calendarSlot.rows).toHaveLength(0);
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
    });

    // guards: BR-WO-020
    it('на два дні (16:00 → завтра 11:00, філія 08–18) → 16:00–18:00 і продовження 08:00–11:00', async () => {
      const h = planningHarness({ workOrders: [] });
      const wo = await h.service.create(
        ORG,
        createDto({
          liftId: LIFT_1,
          plannedAt: kyiv(D, '16:00').toISOString(),
          dueDate: kyiv(D2, '11:00').toISOString(),
        }),
      );
      const [parent, child] = h.liveSlots(wo.id);
      expect([t(parent!.startAt), t(parent!.endAt)]).toEqual([
        t(kyiv(D, '16:00')),
        t(kyiv(D, '18:00')),
      ]);
      expect([t(child!.startAt), t(child!.endAt)]).toEqual([
        t(kyiv(D2, '08:00')),
        t(kyiv(D2, '11:00')),
      ]);
      expect(child!.parentSlotId).toBe(parent!.id);
      expect(child!.liftId).toBe(LIFT_1);
    });

    // guards: BR-WO-020
    it('зайнятий підйомник → 400 «Підйомник зайнятий», наряд не створено', async () => {
      const h = planningHarness({
        workOrders: [woRow({ id: OTHER_WO })],
        slots: [
          slotRow('busy', {
            workOrderId: OTHER_WO,
            startAt: kyiv(D, '11:00'),
            endAt: kyiv(D, '13:00'),
          }),
        ],
      });
      const err = await rejection(
        h.service.create(
          ORG,
          createDto({
            liftId: LIFT_1,
            plannedAt: kyiv(D, '10:00').toISOString(),
            dueDate: kyiv(D, '12:00').toISOString(),
          }),
        ),
      );
      expect(err.message).toBe(LIFT_BUSY);
      expect(h.workOrder.rows.map(w => w.id)).toEqual([OTHER_WO]);
      expect(h.calendarSlot.rows).toHaveLength(1);
    });

    // guards: BR-WO-020
    it('другий день зайнятий → 400 «…наступного дня»', async () => {
      const h = planningHarness({
        workOrders: [woRow({ id: OTHER_WO })],
        slots: [
          slotRow('busy', {
            workOrderId: OTHER_WO,
            startAt: kyiv(D2, '09:00'),
            endAt: kyiv(D2, '10:00'),
          }),
        ],
      });
      const err = await rejection(
        h.service.create(
          ORG,
          createDto({
            liftId: LIFT_1,
            plannedAt: kyiv(D, '16:00').toISOString(),
            dueDate: kyiv(D2, '11:00').toISOString(),
          }),
        ),
      );
      expect(err.message).toBe(LIFT_BUSY_NEXT);
    });

    // guards: BR-WO-020
    it('tenant: запис іншої організації на тому ж підйомнику й часі не заважає і не зачіпається', async () => {
      const foreign = slotRow('foreign', { orgId: OTHER_ORG, workOrderId: null });
      const h = planningHarness({ workOrders: [], slots: [foreign] });
      const wo = await h.service.create(
        ORG,
        createDto({
          liftId: LIFT_1,
          plannedAt: kyiv(D, '10:00').toISOString(),
          dueDate: kyiv(D, '12:00').toISOString(),
        }),
      );
      expect(h.liveSlots(wo.id)).toHaveLength(1);
      expect(foreign.deletedAt).toBeNull();
      // Кожне звернення до записів календаря — у межах своєї організації.
      for (const fn of [h.calendarSlot.findFirst, h.calendarSlot.findMany]) {
        for (const [args] of fn.mock.calls) {
          expect((args as { where: { orgId: string } }).where.orgId).toBe(ORG);
        }
      }
    });
  });

  describe('зміна наряду', () => {
    // guards: BR-WO-020
    it('нові дати → той самий запис переїхав (id, механік, нотатки збережено)', async () => {
      const h = plannedWo({ employeeId: MECH_1, notes: 'клієнт чекає' });
      await h.service.update(ORG, WO_ID, {
        plannedAt: kyiv(D2, '13:00').toISOString(),
        dueDate: kyiv(D2, '15:00').toISOString(),
        liftId: LIFT_1,
      });
      const live = h.liveSlots();
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ id: 'anchor', employeeId: MECH_1, notes: 'клієнт чекає' });
      expect([t(live[0]!.startAt), t(live[0]!.endAt)]).toEqual([
        t(kyiv(D2, '13:00')),
        t(kyiv(D2, '15:00')),
      ]);
    });

    // guards: BR-WO-020
    it('новий час перетинає старий (10–12 → 11–14): власний запис наряду — не конфлікт', async () => {
      const h = plannedWo();
      await h.service.update(ORG, WO_ID, {
        plannedAt: kyiv(D, '11:00').toISOString(),
        dueDate: kyiv(D, '14:00').toISOString(),
      });
      const live = h.liveSlots();
      expect(live.map(s => s.id)).toEqual(['anchor']);
      expect(t(live[0]!.endAt)).toBe(t(kyiv(D, '14:00')));
    });

    // guards: BR-WO-020
    it('зміна підйомника: механік закріплений і за новим → лишається', async () => {
      const h = plannedWo({ employeeId: MECH_BOTH });
      await h.service.update(ORG, WO_ID, { liftId: LIFT_2 });
      expect(h.liveSlots()).toEqual([
        expect.objectContaining({ id: 'anchor', liftId: LIFT_2, employeeId: MECH_BOTH }),
      ]);
    });

    // guards: BR-WO-020, BR-CAL-012
    it('зміна підйомника: механік не закріплений за новим → знімається, запис переїхав', async () => {
      const h = plannedWo({ employeeId: MECH_1 });
      await h.service.update(ORG, WO_ID, { liftId: LIFT_2 });
      expect(h.liveSlots()).toEqual([
        expect.objectContaining({ id: 'anchor', liftId: LIFT_2, employeeId: null }),
      ]);
      expect(h.workOrder.rows[0]!.liftId).toBe(LIFT_2);
    });

    // guards: BR-WO-020
    it('стерто дати → усі записи наряду (і продовження) позначено видаленими, чужі — ні', async () => {
      const other = slotRow('other', {
        workOrderId: OTHER_WO,
        startAt: kyiv(D2, '10:00'),
        endAt: kyiv(D2, '11:00'),
      });
      const cont = slotRow('cont', {
        parentSlotId: 'anchor',
        startAt: kyiv(D2, '08:00'),
        endAt: kyiv(D2, '09:00'),
      });
      const h = plannedWo({}, [cont, other]);
      await h.service.update(ORG, WO_ID, { plannedAt: null, dueDate: null });
      expect(h.liveSlots()).toHaveLength(0);
      expect(h.calendarSlot.rows.find(r => r.id === 'cont')!.deletedAt).toBeInstanceOf(Date);
      expect(other.deletedAt).toBeNull();
      expect(h.workOrder.rows[0]!.plannedAt).toBeNull();
    });

    // guards: BR-WO-020
    it('стерто лише завершення → запис видалено (наряд без пари дат не займає календар)', async () => {
      const h = plannedWo();
      await h.service.update(ORG, WO_ID, { dueDate: null });
      expect(h.liveSlots()).toHaveLength(0);
    });

    // guards: BR-WO-020
    it('зайнятий підйомник на нові дати → 400, і наряд, і запис лишились як були', async () => {
      const busy = slotRow('busy', {
        workOrderId: OTHER_WO,
        startAt: kyiv(D2, '12:00'),
        endAt: kyiv(D2, '14:00'),
      });
      const h = plannedWo({}, [busy]);
      const err = await rejection(
        h.service.update(ORG, WO_ID, {
          plannedAt: kyiv(D2, '13:00').toISOString(),
          dueDate: kyiv(D2, '15:00').toISOString(),
        }),
      );
      expect(err.message).toBe(LIFT_BUSY);
      expect(t(h.workOrder.rows[0]!.plannedAt)).toBe(t(kyiv(D, '10:00')));
      const anchor = h.calendarSlot.rows.find(r => r.id === 'anchor')!;
      expect(t(anchor.startAt)).toBe(t(kyiv(D, '10:00')));
      expect(anchor.deletedAt).toBeNull();
    });

    // guards: BR-WO-020
    it('механік запису зайнятий у новий час → 400 «Механік зайнятий»', async () => {
      const elsewhere = slotRow('elsewhere', {
        workOrderId: OTHER_WO,
        liftId: LIFT_2,
        employeeId: MECH_1,
        startAt: kyiv(D2, '12:00'),
        endAt: kyiv(D2, '14:00'),
      });
      const h = plannedWo({ employeeId: MECH_1 }, [elsewhere]);
      const err = await rejection(
        h.service.update(ORG, WO_ID, {
          plannedAt: kyiv(D2, '13:00').toISOString(),
          dueDate: kyiv(D2, '15:00').toISOString(),
        }),
      );
      expect(err.message).toBe(EMPLOYEE_BUSY);
    });

    // guards: BR-WO-020
    it('запис видаленого наряду на підйомнику не заважає (BR-CAL-011)', async () => {
      const h = planningHarness({
        workOrders: [
          woRow({ liftId: LIFT_1, plannedAt: kyiv(D, '10:00'), dueDate: kyiv(D, '12:00') }),
          woRow({ id: OTHER_WO, deletedAt: new Date('2026-05-19T00:00:00Z') }),
        ],
        slots: [
          slotRow('anchor'),
          slotRow('ghost', {
            workOrderId: OTHER_WO,
            startAt: kyiv(D2, '12:00'),
            endAt: kyiv(D2, '14:00'),
          }),
        ],
      });
      await h.service.update(ORG, WO_ID, {
        plannedAt: kyiv(D2, '13:00').toISOString(),
        dueDate: kyiv(D2, '15:00').toISOString(),
      });
      expect(t(h.liveSlots()[0]!.startAt)).toBe(t(kyiv(D2, '13:00')));
    });

    // guards: BR-WO-020
    it('форма шле ті самі дати й підйомник → записи не чіпаються, транзакції немає', async () => {
      const h = plannedWo();
      await h.service.update(ORG, WO_ID, {
        description: 'лише опис',
        liftId: LIFT_1,
        plannedAt: kyiv(D, '10:00').toISOString(),
        dueDate: kyiv(D, '12:00').toISOString(),
      });
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
      expect(h.calendarSlot.update).not.toHaveBeenCalled();
      expect(h.calendarSlot.create).not.toHaveBeenCalled();
      expect(h.liveSlots()).toHaveLength(1);
    });

    // guards: BR-WO-020
    it('у наряду було кілька записів → після перенесення рівно один (без дубля)', async () => {
      const dup = slotRow('dup', { startAt: kyiv(D2, '08:00'), endAt: kyiv(D2, '09:00') });
      const h = plannedWo({}, [dup]);
      await h.service.update(ORG, WO_ID, {
        plannedAt: kyiv(D, '13:00').toISOString(),
        dueDate: kyiv(D, '14:00').toISOString(),
      });
      expect(h.liveSlots().map(s => s.id)).toEqual(['anchor']);
    });

    // guards: BR-WO-020
    it('наряд без запису (старий) отримує запис, щойно змінили дати', async () => {
      const h = planningHarness({
        workOrders: [woRow({ plannedAt: kyiv('2026-05-01', '10:00'), dueDate: null })],
        slots: [],
      });
      await h.service.update(ORG, WO_ID, {
        plannedAt: kyiv(D, '10:00').toISOString(),
        dueDate: kyiv(D, '11:00').toISOString(),
      });
      expect(h.liveSlots()).toHaveLength(1);
    });

    // guards: BR-WO-020
    it('на два дні при зміні: якір + продовження з parentSlotId, старе продовження видалено', async () => {
      const cont = slotRow('old-cont', {
        parentSlotId: 'anchor',
        startAt: kyiv(D2, '08:00'),
        endAt: kyiv(D2, '09:00'),
      });
      const h = plannedWo({}, [cont]);
      await h.service.update(ORG, WO_ID, {
        plannedAt: kyiv(D, '17:00').toISOString(),
        dueDate: kyiv(D2, '10:00').toISOString(),
      });
      const live = h.liveSlots();
      expect(live.map(s => s.id)).toEqual(['anchor', expect.stringMatching(/^slot-new-/)]);
      expect(live[1]!.parentSlotId).toBe('anchor');
      expect([t(live[1]!.startAt), t(live[1]!.endAt)]).toEqual([
        t(kyiv(D2, '08:00')),
        t(kyiv(D2, '10:00')),
      ]);
      expect(h.calendarSlot.rows.find(r => r.id === 'old-cont')!.deletedAt).toBeInstanceOf(Date);
    });
  });

  // Паралельне бронювання, яке обійшло перевірку зайнятості, зупиняє EXCLUDE
  // `calendar_slots_no_overlap` у БД. Наряд відповідає 409 перекладеним текстом «Підйомник
  // зайнятий», а не 500, і транзакція відкочує наряд разом із записом.
  describe('гонка за підйомник (EXCLUDE у БД)', () => {
    const exclusion = () =>
      new Error('conflicting key value violates exclusion constraint "calendar_slots_no_overlap"');

    async function conflict(p: Promise<unknown>): Promise<Error> {
      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as Error).message).toBe(LIFT_BUSY);
      return err as Error;
    }

    // guards: BR-WO-020
    it('створення: EXCLUDE на записі → 409, наряду немає', async () => {
      const h = planningHarness({ workOrders: [] });
      h.prisma.calendarSlot.create = vi.fn().mockRejectedValue(exclusion());
      await conflict(
        h.service.create(
          ORG,
          createDto({
            liftId: LIFT_1,
            plannedAt: kyiv(D, '10:00').toISOString(),
            dueDate: kyiv(D, '12:00').toISOString(),
          }),
        ),
      );
      expect(h.workOrder.rows).toHaveLength(0);
    });

    // guards: BR-WO-020
    it('зміна дат: EXCLUDE на перенесенні якоря → 409, наряд із попередніми датами', async () => {
      const h = plannedWo();
      h.prisma.calendarSlot.update = vi.fn().mockRejectedValue(exclusion());
      await conflict(
        h.service.update(ORG, WO_ID, {
          plannedAt: kyiv(D2, '10:00').toISOString(),
          dueDate: kyiv(D2, '12:00').toISOString(),
        }),
      );
      expect(t(h.workOrder.rows[0]!.plannedAt)).toBe(t(kyiv(D, '10:00')));
    });

    // guards: BR-WO-020
    it('інша помилка запису календаря не перетворюється на 409 (контроль)', async () => {
      const h = plannedWo();
      const other = new Error('connection reset');
      h.prisma.calendarSlot.update = vi.fn().mockRejectedValue(other);
      await expect(
        h.service.update(ORG, WO_ID, {
          plannedAt: kyiv(D2, '10:00').toISOString(),
          dueDate: kyiv(D2, '12:00').toISOString(),
        }),
      ).rejects.toBe(other);
    });
  });
});
