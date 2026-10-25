import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { CalendarService } from './calendar.service';
import {
  buildSlotStorePrisma,
  fakeSlot,
  FAKE_ORG_ID,
  type FakeSlot,
} from './calendar.spec-fixture';

// Аспект «конфлікти слотів»: createSlot / updateSlot не дають двом слотам перетнутись на
// одному підйомнику чи в одного механіка. Правило — docs/objects/calendar.md, BR-CAL-006.
//
// Проба виконується над сховищем у пам'яті (calendar.spec-fixture.ts), тому кожен кейс
// описує поведінку, а не форму Prisma-запиту. Справжній EXCLUDE-констрейнт у БД перевіряє
// integration-спек (apps/api/src/prisma/schema-integrity.integration.spec.ts) — тут лише
// те, що його порушення перетворюється на 409.

const LIFT_1 = '22222222-2222-4222-8222-222222222222';
const LIFT_2 = '22222222-2222-4222-8222-333333333333';
const MECHANIC = '33333333-3333-4333-8333-333333333333';

// 22.05.2026, травень (+03:00): робочий день 08:00–20:00 Kyiv = 05:00Z–17:00Z.
// Години нижче — UTC.
const at = (hhmm: string, day = '2026-05-22') => new Date(`${day}T${hhmm}:00.000Z`);
const iso = (hhmm: string, day?: string) => at(hhmm, day).toISOString();

const msg = (key: Parameters<typeof translateError>[0]) => translateError(key, 'uk');

function serviceOver(rows: FakeSlot[]) {
  const prisma = buildSlotStorePrisma(rows);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { prisma, service: new CalendarService(prisma as any) };
}

async function expectBadRequest(promise: Promise<unknown>, message: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BadRequestException);
  expect((err as Error).message).toBe(message);
}

describe('CalendarService — конфлікти слотів (BR-CAL-006)', () => {
  describe('createSlot', () => {
    // guards: BR-CAL-006
    it.each([
      ['заходить на початок зайнятого', '09:30', '10:30'],
      ['заходить на кінець зайнятого', '10:30', '11:30'],
      ['лежить усередині зайнятого', '10:15', '10:45'],
      ['накриває зайнятий цілком', '09:00', '12:00'],
      ['збігається із зайнятим хвилина в хвилину', '10:00', '11:00'],
    ])(
      'перетин на тому самому підйомнику (%s) → 400 «підйомник зайнятий», слот не створено',
      async (_label, start, end) => {
        const { prisma, service } = serviceOver([
          fakeSlot({ liftId: LIFT_1, startAt: at('10:00'), endAt: at('11:00') }),
        ]);

        await expectBadRequest(
          service.createSlot(FAKE_ORG_ID, {
            liftId: LIFT_1,
            startAt: iso(start),
            endAt: iso(end),
          }),
          msg('err.calendar.liftBusy'),
        );
        expect(prisma._create).not.toHaveBeenCalled();
        expect(prisma._rows).toHaveLength(1);
      },
    );

    // guards: BR-CAL-006
    it.each([
      ['закінчується рівно тоді, коли починається зайнятий', '09:00', '10:00'],
      ['починається рівно тоді, коли закінчується зайнятий', '11:00', '12:00'],
    ])('дотик меж не є перетином (%s) → слот створюється', async (_label, start, end) => {
      const { prisma, service } = serviceOver([
        fakeSlot({ liftId: LIFT_1, startAt: at('10:00'), endAt: at('11:00') }),
      ]);

      const result = await service.createSlot(FAKE_ORG_ID, {
        liftId: LIFT_1,
        startAt: iso(start),
        endAt: iso(end),
      });

      expect(result.slots).toHaveLength(1);
      expect(prisma._rows).toHaveLength(2);
    });

    // guards: BR-CAL-006
    it('той самий час на іншому підйомнику — не конфлікт', async () => {
      const { prisma, service } = serviceOver([
        fakeSlot({ liftId: LIFT_1, startAt: at('10:00'), endAt: at('11:00') }),
      ]);

      const result = await service.createSlot(FAKE_ORG_ID, {
        liftId: LIFT_2,
        startAt: iso('10:00'),
        endAt: iso('11:00'),
      });

      expect(result.slots[0]).toMatchObject({ liftId: LIFT_2 });
      expect(prisma._rows).toHaveLength(2);
    });

    // guards: BR-CAL-006
    it('видалений слот (deletedAt) час не займає', async () => {
      const { prisma, service } = serviceOver([
        fakeSlot({
          liftId: LIFT_1,
          startAt: at('10:00'),
          endAt: at('11:00'),
          deletedAt: at('08:00'),
        }),
      ]);

      await service.createSlot(FAKE_ORG_ID, {
        liftId: LIFT_1,
        startAt: iso('10:00'),
        endAt: iso('11:00'),
      });

      expect(prisma._create).toHaveBeenCalledTimes(1);
    });

    // guards: BR-CAL-006
    it('слот іншої організації час не займає', async () => {
      const { prisma, service } = serviceOver([
        fakeSlot({ orgId: 'org-2', liftId: LIFT_1, startAt: at('10:00'), endAt: at('11:00') }),
      ]);

      await service.createSlot(FAKE_ORG_ID, {
        liftId: LIFT_1,
        startAt: iso('10:00'),
        endAt: iso('11:00'),
      });

      expect(prisma._create).toHaveBeenCalledTimes(1);
    });

    // guards: BR-CAL-006
    it('механік зайнятий на іншому підйомнику в той самий час → 400 «співробітник зайнятий»', async () => {
      const { prisma, service } = serviceOver([
        fakeSlot({
          liftId: LIFT_1,
          employeeId: MECHANIC,
          startAt: at('10:00'),
          endAt: at('11:00'),
        }),
      ]);

      await expectBadRequest(
        service.createSlot(FAKE_ORG_ID, {
          liftId: LIFT_2,
          employeeId: MECHANIC,
          startAt: iso('10:30'),
          endAt: iso('11:30'),
        }),
        msg('err.calendar.employeeBusy'),
      );
      expect(prisma._create).not.toHaveBeenCalled();
    });

    // guards: BR-CAL-006
    it('механік: дотик меж не є перетином → слот створюється', async () => {
      const { prisma, service } = serviceOver([
        fakeSlot({
          liftId: LIFT_1,
          employeeId: MECHANIC,
          startAt: at('10:00'),
          endAt: at('11:00'),
        }),
      ]);

      await service.createSlot(FAKE_ORG_ID, {
        liftId: LIFT_2,
        employeeId: MECHANIC,
        startAt: iso('11:00'),
        endAt: iso('12:00'),
      });

      expect(prisma._create).toHaveBeenCalledTimes(1);
    });

    // Суть BR-CAL-004: «відкритих» слотів немає — час займає слот у БУДЬ-ЯКОМУ статусі.
    // guards: BR-CAL-004, BR-CAL-006
    it.each(['AVAILABLE', 'BLOCKED'] as const)(
      'наявний слот зі статусом %s (не BOOKED) теж займає підйомник → 400',
      async status => {
        const { prisma, service } = serviceOver([
          fakeSlot({ liftId: LIFT_1, status, startAt: at('10:00'), endAt: at('11:00') }),
        ]);

        await expectBadRequest(
          service.createSlot(FAKE_ORG_ID, {
            liftId: LIFT_1,
            startAt: iso('10:30'),
            endAt: iso('11:30'),
          }),
          msg('err.calendar.liftBusy'),
        );
        expect(prisma._create).not.toHaveBeenCalled();
      },
    );

    // Слот 19:00–21:00 Kyiv (16:00Z–18:00Z) розбивається: 19:00–20:00 сьогодні і 08:00–09:00
    // завтра (05:00Z–06:00Z). Друга частина перевіряється окремою пробою.
    // guards: BR-CAL-006
    it('split-day: продовження наступного дня потрапляє на зайнятий підйомник → 400 «…на наступний день», нічого не створено', async () => {
      const { prisma, service } = serviceOver([
        fakeSlot({
          liftId: LIFT_1,
          startAt: at('05:30', '2026-05-23'),
          endAt: at('06:30', '2026-05-23'),
        }),
      ]);

      await expectBadRequest(
        service.createSlot(FAKE_ORG_ID, {
          liftId: LIFT_1,
          startAt: iso('16:00'),
          endAt: iso('18:00'),
        }),
        msg('err.calendar.liftBusyNextDay'),
      );
      expect(prisma._create).not.toHaveBeenCalled();
    });

    // guards: BR-CAL-006
    it('split-day: продовження наступного дня потрапляє на зайнятого механіка → 400 «…на наступний день»', async () => {
      const { prisma, service } = serviceOver([
        fakeSlot({
          liftId: LIFT_2,
          employeeId: MECHANIC,
          startAt: at('05:30', '2026-05-23'),
          endAt: at('06:30', '2026-05-23'),
        }),
      ]);

      await expectBadRequest(
        service.createSlot(FAKE_ORG_ID, {
          liftId: LIFT_1,
          employeeId: MECHANIC,
          startAt: iso('16:00'),
          endAt: iso('18:00'),
        }),
        msg('err.calendar.employeeBusyNextDay'),
      );
      expect(prisma._create).not.toHaveBeenCalled();
    });

    // Гонка: проба нічого не побачила, а БД відмовила EXCLUDE-констрейнтом.
    // guards: BR-CAL-006
    it('EXCLUDE-порушення (23P01) на вставці → 409 ConflictException, а не 500', async () => {
      const { prisma, service } = serviceOver([]);
      prisma.$transaction = vi
        .fn()
        .mockRejectedValue(
          new Error(
            'exclusion_violation ... constraint "calendar_slots_no_overlap" ... SQLSTATE 23P01',
          ),
        );

      await expect(
        service.createSlot(FAKE_ORG_ID, {
          liftId: LIFT_1,
          startAt: iso('10:00'),
          endAt: iso('11:00'),
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('updateSlot', () => {
    /** Слот, який рухаємо: 09:00–10:00 на LIFT_1; поруч зайнято 10:00–11:00. */
    function twoSlots(over: Partial<FakeSlot> = {}) {
      const moved = fakeSlot({ liftId: LIFT_1, startAt: at('09:00'), endAt: at('10:00') });
      const busy = fakeSlot({
        liftId: LIFT_1,
        startAt: at('10:00'),
        endAt: at('11:00'),
        ...over,
      });
      return { moved, busy, ...serviceOver([moved, busy]) };
    }

    // guards: BR-CAL-006
    it('перенесення на час, зайнятий іншим слотом того самого підйомника → 400, слот не змінено', async () => {
      const { moved, prisma, service } = twoSlots();

      await expectBadRequest(
        service.updateSlot(FAKE_ORG_ID, moved.id, {
          startAt: iso('09:30'),
          endAt: iso('10:30'),
        }),
        msg('err.calendar.liftBusy'),
      );
      expect(prisma._update).not.toHaveBeenCalled();
      expect(moved.startAt).toEqual(at('09:00'));
    });

    // guards: BR-CAL-006
    it('оновлення слота не конфліктує сам із собою: зсув, що перетинає власний старий інтервал, проходить', async () => {
      const moved = fakeSlot({
        liftId: LIFT_1,
        employeeId: MECHANIC,
        startAt: at('09:00'),
        endAt: at('10:00'),
      });
      const { prisma, service } = serviceOver([moved]);

      const result = await service.updateSlot(FAKE_ORG_ID, moved.id, {
        startAt: iso('09:30'),
        endAt: iso('10:30'),
      });

      expect(prisma._update).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ id: moved.id, startAt: iso('09:30'), endAt: iso('10:30') });
    });

    // guards: BR-CAL-006
    it('дотик меж не є перетином: слот можна подовжити впритул до сусіднього', async () => {
      const moved = fakeSlot({ liftId: LIFT_1, startAt: at('08:00'), endAt: at('09:00') });
      const { prisma, service } = serviceOver([
        moved,
        fakeSlot({ liftId: LIFT_1, startAt: at('10:00'), endAt: at('11:00') }),
        fakeSlot({ liftId: LIFT_1, startAt: at('07:00'), endAt: at('08:00') }),
      ]);

      await service.updateSlot(FAKE_ORG_ID, moved.id, { endAt: iso('10:00') });

      expect(prisma._update).toHaveBeenCalledTimes(1);
      expect(moved.endAt).toEqual(at('10:00'));
    });

    // guards: BR-CAL-006
    it('перенесення на інший, вільний підйомник у час, зайнятий на старому, — не конфлікт', async () => {
      const { moved, prisma, service } = twoSlots();

      const result = await service.updateSlot(FAKE_ORG_ID, moved.id, {
        liftId: LIFT_2,
        startAt: iso('10:00'),
        endAt: iso('11:00'),
      });

      expect(prisma._update).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ liftId: LIFT_2 });
    });

    // guards: BR-CAL-006
    it('перенесення на інший підйомник, зайнятий у цей час → 400 (проба йде по НОВОМУ підйомнику)', async () => {
      const { moved, prisma, service } = twoSlots({ liftId: LIFT_2, startAt: at('09:00') });

      await expectBadRequest(
        service.updateSlot(FAKE_ORG_ID, moved.id, { liftId: LIFT_2 }),
        msg('err.calendar.liftBusy'),
      );
      expect(prisma._update).not.toHaveBeenCalled();
    });

    // guards: BR-CAL-006
    it('призначення механіка, зайнятого в цей час на іншому підйомнику → 400 «співробітник зайнятий»', async () => {
      const { moved, prisma, service } = twoSlots({
        liftId: LIFT_2,
        employeeId: MECHANIC,
        startAt: at('09:30'),
      });

      await expectBadRequest(
        service.updateSlot(FAKE_ORG_ID, moved.id, { employeeId: MECHANIC }),
        msg('err.calendar.employeeBusy'),
      );
      expect(prisma._update).not.toHaveBeenCalled();
    });

    // guards: BR-CAL-006
    it('видалений слот (deletedAt) перенесенню не заважає', async () => {
      const { moved, prisma, service } = twoSlots({ deletedAt: at('08:00') });

      await service.updateSlot(FAKE_ORG_ID, moved.id, {
        startAt: iso('09:30'),
        endAt: iso('10:30'),
      });

      expect(prisma._update).toHaveBeenCalledTimes(1);
    });

    // guards: BR-CAL-004, BR-CAL-006
    it.each(['AVAILABLE', 'BLOCKED'] as const)(
      'сусідній слот зі статусом %s (не BOOKED) теж займає підйомник → 400',
      async status => {
        const { moved, prisma, service } = twoSlots({ status });

        await expectBadRequest(
          service.updateSlot(FAKE_ORG_ID, moved.id, {
            startAt: iso('09:30'),
            endAt: iso('10:30'),
          }),
          msg('err.calendar.liftBusy'),
        );
        expect(prisma._update).not.toHaveBeenCalled();
      },
    );

    // guards: BR-CAL-006
    it('EXCLUDE-порушення (23P01) на оновленні → 409 ConflictException, а не 500', async () => {
      const { moved, prisma, service } = twoSlots();
      prisma.$transaction = vi
        .fn()
        .mockRejectedValue(
          new Error(
            'exclusion_violation ... constraint "calendar_slots_no_overlap" ... SQLSTATE 23P01',
          ),
        );

      await expect(
        service.updateSlot(FAKE_ORG_ID, moved.id, { startAt: iso('08:00'), endAt: iso('09:00') }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // Попередження картки наряду (`excludeWorkOrderId`): власні записи наряду — не конфлікт, а
  // бронювання без наряду — конфлікт. Prisma `{ not: X }` відкидає й NULL, тож фільтр лише за
  // `workOrderId <> X` мовчав про записи без наряду (review 2026-10-16).
  describe('checkConflicts з excludeWorkOrderId', () => {
    const OWN_WO = '44444444-4444-4444-8444-444444444444';
    // Живий наряд: не видалений і не скасований (OF_LIVE_WORK_ORDER, BR-WO-022).
    const own = {
      workOrderId: OWN_WO,
      workOrder: { deletedAt: null, status: 'APPROVED' },
    } as Partial<FakeSlot>;

    // guards: BR-CAL-006
    it('запис без наряду на тому самому підйомнику й у механіка → конфлікт', async () => {
      const { service } = serviceOver([
        fakeSlot({
          liftId: LIFT_1,
          employeeId: MECHANIC,
          startAt: at('10:00'),
          endAt: at('11:00'),
        }),
      ]);

      const res = await service.checkConflicts(FAKE_ORG_ID, {
        liftId: LIFT_1,
        employeeId: MECHANIC,
        startAt: iso('10:30'),
        endAt: iso('11:30'),
        excludeWorkOrderId: OWN_WO,
      });

      expect(res).toMatchObject({ liftConflict: true, employeeConflict: true, anyConflict: true });
    });

    // guards: BR-CAL-006
    it('власний запис наряду в той самий час → не конфлікт (контроль виключення)', async () => {
      const { service } = serviceOver([
        fakeSlot({
          ...own,
          liftId: LIFT_1,
          employeeId: MECHANIC,
          startAt: at('10:00'),
          endAt: at('11:00'),
        }),
      ]);

      const res = await service.checkConflicts(FAKE_ORG_ID, {
        liftId: LIFT_1,
        employeeId: MECHANIC,
        startAt: iso('10:30'),
        endAt: iso('11:30'),
        excludeWorkOrderId: OWN_WO,
      });

      expect(res).toMatchObject({
        liftConflict: false,
        employeeConflict: false,
        anyConflict: false,
      });
    });
  });
  // Гонка, яку проба не бачить (READ COMMITTED): два EXCLUDE на одній таблиці — підйомник
  // (`calendar_slots_no_overlap`) і механік (`calendar_slots_mechanic_no_overlap`). Текст 409 мусить
  // назвати саме той ресурс, чий констрейнт спрацював. Помилку подано у формі драйвер-адаптера
  // (`DriverAdapterError`: текст Postgres у message, код 23P01 у cause) — так її віддає `adapter-pg`.
  // Мутація: у `slotExclusionMessages` мапити механічний констрейнт на liftBusy → кейси механіка
  // червоніють; прибрати `.catch` у updateSlotChainDetails → кейс ланцюжка дає не 409.
  describe('EXCLUDE-гонка → 409 з назвою зайнятого ресурсу', () => {
    function exclusion(constraint: string | null): Error {
      const message = constraint
        ? `conflicting key value violates exclusion constraint "${constraint}"`
        : 'conflicting key value violates exclusion constraint';
      const e = new Error(message);
      e.name = 'DriverAdapterError';
      Object.assign(e, { cause: { kind: 'postgres', code: '23P01', message } });
      return e;
    }

    async function rejection(promise: Promise<unknown>): Promise<unknown> {
      return promise.then(
        () => null,
        (e: unknown) => e,
      );
    }

    const MECHANIC_SLOT = { liftId: LIFT_1, employeeId: MECHANIC };

    // guards: BR-CAL-006
    it.each([
      ['calendar_slots_mechanic_no_overlap', 'err.calendar.employeeBusy'],
      ['calendar_slots_no_overlap', 'err.calendar.liftBusy'],
    ] as const)('createSlot: порушено %s → 409 «%s»', async (constraint, key) => {
      const { prisma, service } = serviceOver([]);
      prisma.$transaction = vi.fn().mockRejectedValue(exclusion(constraint));

      const e = await rejection(
        service.createSlot(FAKE_ORG_ID, {
          ...MECHANIC_SLOT,
          startAt: iso('10:00'),
          endAt: iso('11:00'),
        }),
      );

      expect(e).toBeInstanceOf(ConflictException);
      expect((e as ConflictException).message).toBe(msg(key));
    });

    // guards: BR-CAL-006
    it.each([
      ['calendar_slots_mechanic_no_overlap', 'err.calendar.employeeBusy'],
      ['calendar_slots_no_overlap', 'err.calendar.liftBusy'],
    ] as const)('updateSlot: порушено %s → 409 «%s»', async (constraint, key) => {
      const moved = fakeSlot({ ...MECHANIC_SLOT, startAt: at('09:00'), endAt: at('10:00') });
      const { prisma, service } = serviceOver([moved]);
      prisma.$transaction = vi.fn().mockRejectedValue(exclusion(constraint));

      const e = await rejection(
        service.updateSlot(FAKE_ORG_ID, moved.id, { startAt: iso('08:00'), endAt: iso('09:00') }),
      );

      expect(e).toBeInstanceOf(ConflictException);
      expect((e as ConflictException).message).toBe(msg(key));
    });

    // Механік ланцюжка запису наряду міняється без перебудови (BR-WO-027) — та сама гонка.
    // guards: BR-CAL-006
    it('updateSlotChainDetails: механічний EXCLUDE → 409 «механік зайнятий», а не 500', async () => {
      const { prisma, service } = serviceOver([]);
      prisma.$transaction = vi
        .fn()
        .mockRejectedValue(exclusion('calendar_slots_mechanic_no_overlap'));

      const e = await rejection(
        service.updateSlotChainDetails(
          FAKE_ORG_ID,
          [{ id: 'slot-1', startAt: at('10:00'), endAt: at('11:00') }],
          { employeeId: MECHANIC },
        ),
      );

      expect(e).toBeInstanceOf(ConflictException);
      expect((e as ConflictException).message).toBe(msg('err.calendar.employeeBusy'));
    });

    // guards: BR-CAL-006
    it('23P01 без назви констрейнта → 409 «підйомник зайнятий»; інша помилка БД іде як є', async () => {
      const { prisma, service } = serviceOver([]);
      const input = { ...MECHANIC_SLOT, startAt: iso('10:00'), endAt: iso('11:00') };

      prisma.$transaction = vi.fn().mockRejectedValue(exclusion(null));
      const unnamed = await rejection(service.createSlot(FAKE_ORG_ID, input));
      expect(unnamed).toBeInstanceOf(ConflictException);
      expect((unnamed as ConflictException).message).toBe(msg('err.calendar.liftBusy'));

      const other = new Error('connection terminated unexpectedly');
      prisma.$transaction = vi.fn().mockRejectedValue(other);
      expect(await rejection(service.createSlot(FAKE_ORG_ID, input))).toBe(other);
    });
  });
});
