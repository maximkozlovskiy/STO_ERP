import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { CalendarService } from './calendar.service';
import {
  buildSlotStorePrisma,
  fakeSlot,
  matchesWhere,
  FAKE_ORG_ID,
  type FakeSlot,
} from './calendar.spec-fixture';

// Аспект «механік запису закріплений за підйомником»: createSlot / updateSlot приймають механіка
// лише активного (не звільненого, не видаленого) MECHANIC своєї організації, закріпленого за
// підйомником запису. Правило — docs/objects/calendar.md, BR-CAL-012.
//
// Працівники — таблиця в пам'яті, що ВИКОНУЄ Prisma `where` (`matchesWhere` фікстури, зокрема
// `employeeLifts: { some }`): мок «знайшовся / ні» не відрізнив би запит без умови на роль,
// статус чи закріплення від правильного.

const LIFT_1 = '22222222-2222-4222-8222-222222222222';
const LIFT_2 = '22222222-2222-4222-8222-333333333333';
const MECH = '33333333-3333-4333-8333-000000000001';
const MECH_BOTH = '33333333-3333-4333-8333-000000000002';
const MECH_LIFT_2 = '33333333-3333-4333-8333-000000000003';
const RECEPTIONIST = '33333333-3333-4333-8333-000000000004';
const FIRED = '33333333-3333-4333-8333-000000000005';
const DELETED = '33333333-3333-4333-8333-000000000006';
const FOREIGN = '33333333-3333-4333-8333-000000000007';
const ON_LEAVE = '33333333-3333-4333-8333-000000000008';

function employee(id: string, lifts: string[], over: Record<string, unknown> = {}) {
  return {
    id,
    orgId: FAKE_ORG_ID,
    role: 'MECHANIC',
    status: 'ACTIVE',
    deletedAt: null as Date | null,
    employeeLifts: lifts.map(liftId => ({ liftId })),
    ...over,
  };
}

const EMPLOYEES = [
  employee(MECH, [LIFT_1]),
  employee(MECH_BOTH, [LIFT_1, LIFT_2]),
  employee(MECH_LIFT_2, [LIFT_2]),
  employee(RECEPTIONIST, [LIFT_1], { role: 'RECEPTIONIST' }),
  employee(FIRED, [LIFT_1], { status: 'FIRED' }),
  employee(DELETED, [LIFT_1], { deletedAt: new Date('2026-05-01T00:00:00Z') }),
  employee(FOREIGN, [LIFT_1], { orgId: 'org-2' }),
  employee(ON_LEAVE, [LIFT_1], { status: 'ON_LEAVE' }),
];

// 22.05.2026, травень (+03:00): робочий день 08:00–20:00 Kyiv = 05:00Z–17:00Z. Години — UTC.
const at = (hhmm: string, day = '2026-05-22') => new Date(`${day}T${hhmm}:00.000Z`);
const iso = (hhmm: string, day?: string) => at(hhmm, day).toISOString();

const NOT_ON_LIFT = translateError('err.calendar.employeeNotOnLift', 'uk');

function serviceOver(rows: FakeSlot[]) {
  const prisma = buildSlotStorePrisma(rows);
  const employeeFindFirst = vi.fn(({ where }: { where: Record<string, unknown> }) => {
    const found = EMPLOYEES.find(e => matchesWhere(e, where));
    return Promise.resolve(found ? { id: found.id } : null);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new CalendarService({
    ...prisma,
    employee: { findFirst: employeeFindFirst },
  } as any);
  return { prisma, service, employeeFindFirst };
}

async function expectNotOnLift(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BadRequestException);
  expect((err as Error).message).toBe(NOT_ON_LIFT);
}

describe('CalendarService — механік запису закріплений за підйомником (BR-CAL-012)', () => {
  describe('createSlot', () => {
    // guards: BR-CAL-012
    it.each([
      ['активний механік, закріплений лише за цим підйомником', MECH],
      ['механік, закріплений за кількома підйомниками', MECH_BOTH],
    ])('%s → запис створено з механіком', async (_label, employeeId) => {
      const { prisma, service } = serviceOver([]);
      const res = await service.createSlot(FAKE_ORG_ID, {
        liftId: LIFT_1,
        employeeId,
        startAt: iso('07:00'),
        endAt: iso('08:00'),
      });
      expect(res.slots).toHaveLength(1);
      expect(prisma._rows).toHaveLength(1);
      expect(prisma._rows[0].employeeId).toBe(employeeId);
    });

    // guards: BR-CAL-012
    it.each([
      ['не MECHANIC (адміністратор), хоч і закріплений', RECEPTIONIST, LIFT_1],
      ['звільнений (FIRED)', FIRED, LIFT_1],
      ['у відпустці (ON_LEAVE), хоч і закріплений', ON_LEAVE, LIFT_1],
      ['видалений', DELETED, LIFT_1],
      ['з іншої організації', FOREIGN, LIFT_1],
      ['не закріплений за підйомником запису', MECH_LIFT_2, LIFT_1],
      ['неіснуючий', '33333333-3333-4333-8333-0000000000ff', LIFT_1],
    ])('механік %s → 400, запис не створено', async (_label, employeeId, liftId) => {
      const { prisma, service } = serviceOver([]);
      await expectNotOnLift(
        service.createSlot(FAKE_ORG_ID, {
          liftId,
          employeeId,
          startAt: iso('07:00'),
          endAt: iso('08:00'),
        }),
      );
      expect(prisma._create).not.toHaveBeenCalled();
    });

    // guards: BR-CAL-012
    it('механік без підйомника → 400: закріпитись нема за чим, працівників не читає', async () => {
      const { prisma, service, employeeFindFirst } = serviceOver([]);
      await expectNotOnLift(
        service.createSlot(FAKE_ORG_ID, {
          employeeId: MECH,
          startAt: iso('07:00'),
          endAt: iso('08:00'),
        }),
      );
      expect(employeeFindFirst).not.toHaveBeenCalled();
      expect(prisma._create).not.toHaveBeenCalled();
    });

    // guards: BR-CAL-012
    it('без механіка — перевірки немає, запис створено', async () => {
      const { prisma, service, employeeFindFirst } = serviceOver([]);
      await service.createSlot(FAKE_ORG_ID, {
        liftId: LIFT_1,
        startAt: iso('07:00'),
        endAt: iso('08:00'),
      });
      expect(employeeFindFirst).not.toHaveBeenCalled();
      expect(prisma._rows).toHaveLength(1);
    });

    // guards: BR-CAL-012
    it('багатоденний запис: закріплений механік — на обох частинах; не закріплений — 400, нічого', async () => {
      // 16:00–23:00 Kyiv (13:00Z–20:00Z): ділиться на 20:00, продовження — наступного дня з 08:00.
      const ok = serviceOver([]);
      const res = await ok.service.createSlot(FAKE_ORG_ID, {
        liftId: LIFT_1,
        employeeId: MECH,
        startAt: iso('13:00'),
        endAt: iso('20:00'),
      });
      expect(res.slots).toHaveLength(2);
      expect(ok.prisma._rows.map(r => r.employeeId)).toEqual([MECH, MECH]);
      expect(ok.prisma._rows[1].parentSlotId).toBe(ok.prisma._rows[0].id);

      const bad = serviceOver([]);
      await expectNotOnLift(
        bad.service.createSlot(FAKE_ORG_ID, {
          liftId: LIFT_1,
          employeeId: MECH_LIFT_2,
          startAt: iso('13:00'),
          endAt: iso('20:00'),
        }),
      );
      expect(bad.prisma._rows).toHaveLength(0);
    });
  });

  describe('updateSlot', () => {
    const saved = (over: Partial<FakeSlot> = {}) =>
      fakeSlot({
        liftId: LIFT_1,
        employeeId: MECH,
        startAt: at('07:00'),
        endAt: at('08:00'),
        ...over,
      });

    // guards: BR-CAL-012
    it.each([
      ['не закріпленого за підйомником', MECH_LIFT_2],
      ['звільненого', FIRED],
      ['у відпустці', ON_LEAVE],
      ['не MECHANIC', RECEPTIONIST],
      ['з іншої організації', FOREIGN],
    ])('зміна механіка на %s → 400, запис не змінено', async (_label, employeeId) => {
      const slot = saved();
      const { prisma, service } = serviceOver([slot]);
      await expectNotOnLift(service.updateSlot(FAKE_ORG_ID, slot.id, { employeeId }));
      expect(prisma._update).not.toHaveBeenCalled();
      expect(slot.employeeId).toBe(MECH);
    });

    // guards: BR-CAL-012
    it('зміна механіка на закріпленого → збережено', async () => {
      const slot = saved();
      const { service } = serviceOver([slot]);
      await service.updateSlot(FAKE_ORG_ID, slot.id, { employeeId: MECH_BOTH });
      expect(slot.employeeId).toBe(MECH_BOTH);
    });

    // guards: BR-CAL-012
    it('зміна підйомника, механік не закріплений за новим → 400, запис не змінено', async () => {
      const slot = saved();
      const { prisma, service } = serviceOver([slot]);
      await expectNotOnLift(service.updateSlot(FAKE_ORG_ID, slot.id, { liftId: LIFT_2 }));
      expect(prisma._update).not.toHaveBeenCalled();
      expect(slot.liftId).toBe(LIFT_1);
    });

    // guards: BR-CAL-012
    it('зміна підйомника, механік закріплений і за новим → збережено', async () => {
      const slot = saved({ employeeId: MECH_BOTH });
      const { service } = serviceOver([slot]);
      await service.updateSlot(FAKE_ORG_ID, slot.id, { liftId: LIFT_2 });
      expect(slot.liftId).toBe(LIFT_2);
    });

    // guards: BR-CAL-012
    it('зміна підйомника разом зі зняттям механіка (null) → збережено без перевірки', async () => {
      const slot = saved();
      const { service, employeeFindFirst } = serviceOver([slot]);
      await service.updateSlot(FAKE_ORG_ID, slot.id, { liftId: LIFT_2, employeeId: null });
      expect(employeeFindFirst).not.toHaveBeenCalled();
      expect(slot).toMatchObject({ liftId: LIFT_2, employeeId: null });
    });

    // guards: BR-CAL-012
    it.each([
      ['форма шле ті самі механіка й підйомника', { liftId: LIFT_1, employeeId: FIRED }],
      ['запит без механіка й підйомника', {}],
    ])(
      'збережений звільнений механік, %s, змінено час → збережено без перевірки',
      async (_label, fields) => {
        const slot = saved({ employeeId: FIRED });
        const { service, employeeFindFirst } = serviceOver([slot]);
        await service.updateSlot(FAKE_ORG_ID, slot.id, {
          ...fields,
          startAt: iso('09:00'),
          endAt: iso('10:00'),
        });
        expect(employeeFindFirst).not.toHaveBeenCalled();
        expect(slot.startAt.toISOString()).toBe(iso('09:00'));
        expect(slot.employeeId).toBe(FIRED);
      },
    );
  });
});

// Перетягування чи зміна меж запису у «Дні» (рішення власника 2026-10-16): web шле
// `dropMechanicNotOnLift: true`, і механік запису, не закріплений за новим підйомником, знімається
// (`employeeId: null`) замість 400. Форма запису прапорця не шле — для неї й далі 400.
describe('CalendarService.updateSlot — перетягування знімає незакріпленого механіка (BR-CAL-012)', () => {
  const saved = (over: Partial<FakeSlot> = {}) =>
    fakeSlot({
      liftId: LIFT_1,
      employeeId: MECH,
      startAt: at('07:00'),
      endAt: at('08:00'),
      ...over,
    });

  // guards: BR-CAL-012
  it.each([
    ['не закріплений за новим підйомником', MECH],
    ['у відпустці', ON_LEAVE],
    ['звільнений', FIRED],
  ])(
    'механік %s → запис на новому підйомнику без механіка, відповідь mechanicDropped',
    async (_label, employeeId) => {
      const slot = saved({ employeeId });
      const { service } = serviceOver([slot]);
      const res = await service.updateSlot(FAKE_ORG_ID, slot.id, {
        liftId: LIFT_2,
        startAt: iso('09:00'),
        endAt: iso('10:00'),
        dropMechanicNotOnLift: true,
      });
      expect(slot).toMatchObject({ liftId: LIFT_2, employeeId: null });
      expect(slot.startAt.toISOString()).toBe(iso('09:00'));
      expect(res.employeeId).toBeNull();
      expect(res.mechanicDropped).toBe(true);
    },
  );

  // guards: BR-CAL-012
  it('механік закріплений і за новим підйомником → лишається, mechanicDropped немає', async () => {
    const slot = saved({ employeeId: MECH_BOTH });
    const { service } = serviceOver([slot]);
    const res = await service.updateSlot(FAKE_ORG_ID, slot.id, {
      liftId: LIFT_2,
      dropMechanicNotOnLift: true,
    });
    expect(slot).toMatchObject({ liftId: LIFT_2, employeeId: MECH_BOTH });
    expect(res).not.toHaveProperty('mechanicDropped');
  });

  // guards: BR-CAL-012
  it('запис без механіка → просто переміщено, працівників не читає', async () => {
    const slot = saved({ employeeId: null });
    const { service, employeeFindFirst } = serviceOver([slot]);
    const res = await service.updateSlot(FAKE_ORG_ID, slot.id, {
      liftId: LIFT_2,
      dropMechanicNotOnLift: true,
    });
    expect(slot).toMatchObject({ liftId: LIFT_2, employeeId: null });
    expect(employeeFindFirst).not.toHaveBeenCalled();
    expect(res).not.toHaveProperty('mechanicDropped');
  });

  // guards: BR-CAL-012
  it('без прапорця (форма) — як і раніше 400, запис не змінено', async () => {
    const slot = saved();
    const { prisma, service } = serviceOver([slot]);
    await expectNotOnLift(service.updateSlot(FAKE_ORG_ID, slot.id, { liftId: LIFT_2 }));
    expect(prisma._update).not.toHaveBeenCalled();
    expect(slot).toMatchObject({ liftId: LIFT_1, employeeId: MECH });
  });

  // guards: BR-CAL-012
  it('явно обраний ІНШИЙ незакріплений механік із прапорцем → 400: знімається лише свій механік', async () => {
    const slot = saved();
    const { prisma, service } = serviceOver([slot]);
    await expectNotOnLift(
      service.updateSlot(FAKE_ORG_ID, slot.id, {
        liftId: LIFT_2,
        employeeId: FIRED,
        dropMechanicNotOnLift: true,
      }),
    );
    expect(prisma._update).not.toHaveBeenCalled();
    expect(slot).toMatchObject({ liftId: LIFT_1, employeeId: MECH });
  });

  // guards: BR-CAL-012
  it('знятий механік не перевіряється на зайнятість: його інший запис у цей час не заважає', async () => {
    const slot = saved();
    // Той самий механік уже має запис на підйомнику 1 у час, куди переносять.
    const busy = fakeSlot({
      liftId: LIFT_1,
      employeeId: MECH,
      startAt: at('09:00'),
      endAt: at('10:00'),
    });
    const { service } = serviceOver([slot, busy]);
    const res = await service.updateSlot(FAKE_ORG_ID, slot.id, {
      liftId: LIFT_2,
      startAt: iso('09:00'),
      endAt: iso('10:00'),
      dropMechanicNotOnLift: true,
    });
    expect(res.mechanicDropped).toBe(true);
    expect(slot).toMatchObject({ liftId: LIFT_2, employeeId: null });
  });
});
