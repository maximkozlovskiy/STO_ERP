import { describe, it, expect, vi } from 'vitest';
import { CalendarService } from './calendar.service';
import {
  buildSlotStorePrisma,
  fakeSlot,
  FAKE_ORG_ID,
  type FakeSlot,
} from './calendar.spec-fixture';

// Записи видаленого наряду (рішення власника 2026-10-16): видалення наряду позначає видаленими і
// його записи (BR-WO-017, `work-orders.remove-calendar.spec.ts`). Тут — запис, що ПЕРЕЖИВ
// видалення наряду (дані до міграції-бекфілу): календар його не показує (BR-CAL-011) і не
// вважає зайнятим підйомник чи механіка.
//
// Сховище виконує Prisma `where` (`matchesWhere`, зокрема `AND` і зв'язок `workOrder: { is }`),
// тож тест бачить, КОГО відбирає запит, а не його форму.

const LIFT = '22222222-2222-4222-8222-222222222222';
const MECH = '33333333-3333-4333-8333-000000000001';
const DELETED_AT = new Date('2026-06-01T09:00:00Z');

// 15.06.2026 (+03:00): 10:00–12:00 Kyiv = 07:00Z–09:00Z.
const at = (hhmm: string) => new Date(`2026-06-15T${hhmm}:00.000Z`);
const iso = (hhmm: string) => at(hhmm).toISOString();

const orphan = (over: Partial<FakeSlot> = {}) =>
  fakeSlot({
    liftId: LIFT,
    employeeId: MECH,
    workOrderId: 'wo-deleted',
    workOrder: { deletedAt: DELETED_AT, number: 'НРД-9', status: 'DRAFT' },
    startAt: at('07:00'),
    endAt: at('09:00'),
    ...over,
  });

const live = (over: Partial<FakeSlot> = {}) =>
  fakeSlot({
    liftId: LIFT,
    workOrderId: 'wo-live',
    workOrder: { deletedAt: null, number: 'НРД-1', status: 'APPROVED' },
    startAt: at('10:00'),
    endAt: at('11:00'),
    ...over,
  });

function serviceOver(rows: FakeSlot[]) {
  const prisma = buildSlotStorePrisma(rows);
  const names = vi.fn().mockResolvedValue([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new CalendarService({
    ...prisma,
    employee: { ...prisma.employee, findMany: names },
  } as any);
  return { prisma, service };
}

describe('CalendarService — записи видаленого наряду (BR-CAL-011, BR-WO-017)', () => {
  // guards: BR-CAL-011
  it.each(['ADMIN', 'MECHANIC'])(
    '%s: findSlots не повертає запис видаленого наряду; живий наряд і запис без наряду — так',
    async role => {
      const gone = orphan();
      const kept = live();
      const free = fakeSlot({ liftId: LIFT, startAt: at('12:00'), endAt: at('13:00') });
      const { service } = serviceOver([gone, kept, free]);

      const slots = await service.findSlots(FAKE_ORG_ID, '2026-06-15', role);

      expect(slots.map(s => s.id).sort()).toEqual([kept.id, free.id].sort());
      expect(slots.every(s => s.workOrderDeleted === false)).toBe(true);
    },
  );

  // guards: BR-CAL-011
  it('createSlot: підйомник і механік у час запису видаленого наряду вільні — запис створено', async () => {
    const gone = orphan();
    const { prisma, service } = serviceOver([gone]);

    const res = await service.createSlot(FAKE_ORG_ID, {
      liftId: LIFT,
      startAt: iso('07:00'),
      endAt: iso('09:00'),
    });

    expect(res.slots).toHaveLength(1);
    expect(prisma._rows).toHaveLength(2);
  });

  // guards: BR-CAL-011
  it('createSlot: запис ЖИВОГО наряду в той самий час і далі займає підйомник — 400', async () => {
    const busy = live({ startAt: at('07:00'), endAt: at('09:00') });
    const { prisma, service } = serviceOver([busy]);

    await expect(
      service.createSlot(FAKE_ORG_ID, { liftId: LIFT, startAt: iso('07:30'), endAt: iso('08:30') }),
    ).rejects.toThrow('Підйомник');
    expect(prisma._create).not.toHaveBeenCalled();
  });

  // guards: BR-CAL-011
  it('updateSlot: перенесення на час запису видаленого наряду — без конфлікту', async () => {
    const gone = orphan();
    const moving = live();
    const { service } = serviceOver([gone, moving]);

    await service.updateSlot(FAKE_ORG_ID, moving.id, {
      startAt: iso('07:30'),
      endAt: iso('08:30'),
    });

    expect(moving.startAt.toISOString()).toBe(iso('07:30'));
  });

  // guards: BR-CAL-011
  it('checkConflicts: запис видаленого наряду не конфлікт ні за підйомником, ні за механіком', async () => {
    const gone = orphan();
    const { service } = serviceOver([gone]);

    const res = await service.checkConflicts(FAKE_ORG_ID, {
      liftId: LIFT,
      employeeId: MECH,
      startAt: iso('07:00'),
      endAt: iso('09:00'),
    });

    expect(res).toMatchObject({ liftConflict: false, employeeConflict: false, anyConflict: false });
  });

  // guards: BR-CAL-011
  it('checkConflicts: живий наряд у той самий час — конфлікт (контроль фільтра)', async () => {
    const busy = live({ employeeId: MECH, startAt: at('07:00'), endAt: at('09:00') });
    const { service } = serviceOver([busy]);

    const res = await service.checkConflicts(FAKE_ORG_ID, {
      liftId: LIFT,
      employeeId: MECH,
      startAt: iso('08:00'),
      endAt: iso('10:00'),
    });

    expect(res).toMatchObject({ liftConflict: true, employeeConflict: true, anyConflict: true });
  });

  // Запис скасованого наряду так само невидимий (BR-WO-022), але EXCLUDE `calendar_slots_no_overlap`
  // бачить кожен живий запис: прив'язаний до скасованого наряду, він тримав би підйомник непомітно.
  // guards: BR-WO-022
  it("createSlot: прив'язати запис до СКАСОВАНОГО наряду — 400, запис не створено", async () => {
    const { prisma, service } = serviceOver([]);
    prisma.workOrder.findFirst.mockResolvedValueOnce({ id: 'wo-cancelled', status: 'CANCELLED' });

    await expect(
      service.createSlot(FAKE_ORG_ID, {
        liftId: LIFT,
        workOrderId: 'wo-cancelled',
        startAt: iso('07:00'),
        endAt: iso('09:00'),
      }),
    ).rejects.toThrow('Наряд скасовано');
    expect(prisma._create).not.toHaveBeenCalled();
  });

  // guards: BR-WO-022
  it("updateSlot: перев'язати запис на СКАСОВАНИЙ наряд — 400, запис без змін", async () => {
    const moving = live();
    const { prisma, service } = serviceOver([moving]);
    prisma.workOrder.findFirst.mockResolvedValueOnce({ id: 'wo-cancelled', status: 'CANCELLED' });

    await expect(
      service.updateSlot(FAKE_ORG_ID, moving.id, { workOrderId: 'wo-cancelled' }),
    ).rejects.toThrow('Наряд скасовано');
    expect(prisma._update).not.toHaveBeenCalled();
    expect(moving.workOrderId).toBe('wo-live');
  });
});
