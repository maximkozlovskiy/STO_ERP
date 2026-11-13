/**
 * Зміна багатоденного ручного запису як ланцюжка (BR-CAL-020; рішення власника 2026-11-13,
 * TECH-DEBT (б) №92). Запис без наряду, що є частиною ланцюжка, змінюється з будь-якої частини як
 * ціле: з `chainSpan` `startAt` / `endAt` — межі всього ланцюжка; без нього — межі частини
 * (крайня — нові межі ланцюжка, внутрішня — 400). Нові межі чи підйомник перебудовують ланцюжок
 * поділом створення (`manualSlotSegments`, години філії НОВОГО підйомника): якір — перша частина,
 * продовження — наступні по порядку, бракує — створюються, зайві — soft delete. Інші поля — для
 * всіх частин.
 *
 * Сховище в пам'яті (`calendar.spec-fixture.ts`) справді обчислює `where`: проба зайнятості без
 * власних частин, тенант і soft delete перевіряються поведінкою, а не формою запиту. Філія
 * підйомника фікстури — 08:00–20:00 щодня; `lift-b` — філія з 09:00–18:00 пн–пт. 22.05.2026 — пт,
 * +03:00.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { CalendarService } from './calendar.service';
import {
  buildSlotStorePrisma,
  fakeSlot,
  FAKE_BRANCH_ID,
  FAKE_ORG_ID as ORG,
  type FakeSlot,
} from './calendar.spec-fixture';

const kyiv = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+03:00`);
const iso = (ymd: string, hm: string) => kyiv(ymd, hm).toISOString();
const msg = (key: string) => translateError(key, 'uk');

const FRI = '2026-05-22';
const SAT = '2026-05-23';
const SUN = '2026-05-24';
const MON = '2026-05-25';
const TUE = '2026-05-26';
const WED = '2026-05-27';

/** Ручний запис на три дні: пт 16–20, сб 08–20, нд 08–10 на `lift-1`. */
function chain(over: Partial<FakeSlot> = {}): FakeSlot[] {
  return [
    fakeSlot({
      id: 'a',
      liftId: 'lift-1',
      startAt: kyiv(FRI, '16:00'),
      endAt: kyiv(FRI, '20:00'),
      ...over,
    }),
    fakeSlot({
      id: 'a2',
      liftId: 'lift-1',
      parentSlotId: 'a',
      startAt: kyiv(SAT, '08:00'),
      endAt: kyiv(SAT, '20:00'),
      ...over,
    }),
    fakeSlot({
      id: 'a3',
      liftId: 'lift-1',
      parentSlotId: 'a',
      startAt: kyiv(SUN, '08:00'),
      endAt: kyiv(SUN, '10:00'),
      ...over,
    }),
  ];
}

/** Сервіс над сховищем; `lift-b` — у філії `branch-2` з 09–18 пн–пт. */
function service(rows: FakeSlot[]) {
  const prisma = buildSlotStorePrisma(rows);
  prisma.lift.findFirst = vi.fn(({ where }: { where: { id: string } }) =>
    Promise.resolve({
      id: where.id,
      zone: { branchId: where.id === 'lift-b' ? 'branch-2' : FAKE_BRANCH_ID },
    }),
  );
  prisma.branchSettings.findFirst = vi.fn(({ where }: { where: { branchId: string } }) =>
    Promise.resolve(
      where.branchId === 'branch-2'
        ? { workStartTime: '09:00', workEndTime: '18:00', workDays: [1, 2, 3, 4, 5] }
        : { workStartTime: '08:00', workEndTime: '20:00', workDays: [1, 2, 3, 4, 5, 6, 7] },
    ),
  );
  return { prisma, svc: new CalendarService(prisma as never) };
}

/** Живі частини ланцюжка `a` організації: [id, parentSlotId, початок, кінець] за часом. */
function liveChain(rows: FakeSlot[]) {
  return rows
    .filter(
      r => r.orgId === ORG && r.deletedAt === null && (r.id === 'a' || r.parentSlotId === 'a'),
    )
    .sort((x, y) => x.startAt.getTime() - y.startAt.getTime())
    .map(r => [r.id, r.parentSlotId, r.startAt.toISOString(), r.endAt.toISOString()]);
}

const span = (ymd: string, from: string, to: string) => [iso(ymd, from), iso(ymd, to)];

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

describe('CalendarService.updateSlot — ручний ланцюжок як ціле (BR-CAL-020)', () => {
  // guards: BR-CAL-020
  it('chainSpan із середньої частини: новий кінець пізніше — бракує частини, вона створюється', async () => {
    const rows = chain();
    const { svc } = service(rows);

    const res = await svc.updateSlot(ORG, 'a2', {
      startAt: iso(FRI, '16:00'),
      endAt: iso(MON, '12:00'),
      chainSpan: true,
    });

    const live = liveChain(rows);
    expect(
      live.map(([id, parent, ...t]) => [
        id === 'a' || id === 'a2' || id === 'a3' ? id : 'new',
        parent,
        ...t,
      ]),
    ).toEqual([
      ['a', null, ...span(FRI, '16:00', '20:00')],
      ['a2', 'a', ...span(SAT, '08:00', '20:00')],
      ['a3', 'a', ...span(SUN, '08:00', '20:00')],
      ['new', 'a', ...span(MON, '08:00', '12:00')],
    ]);
    expect(res).toMatchObject({
      id: 'a2',
      chainDays: 4,
      chainStartAt: iso(FRI, '16:00'),
      chainEndAt: iso(MON, '12:00'),
    });
  });

  // guards: BR-CAL-020
  it('chainSpan: кінець раніше — зайва частина soft delete, відповідь — якір, якщо змінену прибрано', async () => {
    const rows = chain();
    const { svc } = service(rows);

    const res = await svc.updateSlot(ORG, 'a3', {
      startAt: iso(FRI, '16:00'),
      endAt: iso(SAT, '12:00'),
      chainSpan: true,
    });

    expect(liveChain(rows)).toEqual([
      ['a', null, ...span(FRI, '16:00', '20:00')],
      ['a2', 'a', ...span(SAT, '08:00', '12:00')],
    ]);
    expect(rows.find(r => r.id === 'a3')?.deletedAt).toBeInstanceOf(Date);
    expect(res).toMatchObject({ id: 'a', chainDays: 2, chainEndAt: iso(SAT, '12:00') });
  });

  // guards: BR-CAL-020
  it('без chainSpan: кінець останнього дня — нові межі ланцюжка; початок першого — теж', async () => {
    const rows = chain();
    const { svc } = service(rows);

    await svc.updateSlot(ORG, 'a3', { startAt: iso(SUN, '08:00'), endAt: iso(SUN, '14:00') });
    expect(liveChain(rows)).toEqual([
      ['a', null, ...span(FRI, '16:00', '20:00')],
      ['a2', 'a', ...span(SAT, '08:00', '20:00')],
      ['a3', 'a', ...span(SUN, '08:00', '14:00')],
    ]);

    await svc.updateSlot(ORG, 'a', { startAt: iso(FRI, '18:00'), endAt: iso(FRI, '20:00') });
    expect(liveChain(rows)[0]).toEqual(['a', null, ...span(FRI, '18:00', '20:00')]);
    expect(liveChain(rows)).toHaveLength(3);
  });

  // guards: BR-CAL-020
  it.each([
    ['кінець першого дня', 'a', span(FRI, '16:00', '19:00')],
    ['початок продовження', 'a2', span(SAT, '09:00', '20:00')],
    ['продовження цілком (перетягування без chainSpan)', 'a2', span(SAT, '09:00', '21:00')],
  ] as const)(
    'внутрішня межа (%s) → 400 chainInnerEdge, ланцюжок без змін',
    async (_l, id, [s, e]) => {
      const rows = chain();
      const before = structuredClone(rows);
      const { svc } = service(rows);

      const err = await rejection(svc.updateSlot(ORG, id, { startAt: s, endAt: e }));

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toBe(msg('err.calendar.chainInnerEdge'));
      expect(rows).toEqual(before);
    },
  );

  // guards: BR-CAL-020
  it('chainSpan із продовження зсуває весь ланцюжок — продовження не відривається від якоря', async () => {
    const rows = chain();
    const { svc } = service(rows);

    await svc.updateSlot(ORG, 'a2', {
      startAt: iso(FRI, '18:00'),
      endAt: iso(SUN, '12:00'),
      chainSpan: true,
    });

    expect(liveChain(rows)).toEqual([
      ['a', null, ...span(FRI, '18:00', '20:00')],
      ['a2', 'a', ...span(SAT, '08:00', '20:00')],
      ['a3', 'a', ...span(SUN, '08:00', '12:00')],
    ]);
  });

  // guards: BR-CAL-020, BR-CAL-016, BR-CAL-017
  it('підйомник іншої філії: частини — за її годинами й днями (вихідні пропущено)', async () => {
    const rows = chain();
    const { svc } = service(rows);

    await svc.updateSlot(ORG, 'a', {
      liftId: 'lift-b',
      startAt: iso(FRI, '16:00'),
      endAt: iso(TUE, '12:00'),
      chainSpan: true,
    });

    expect(liveChain(rows)).toEqual([
      ['a', null, ...span(FRI, '16:00', '18:00')],
      ['a2', 'a', ...span(MON, '09:00', '18:00')],
      ['a3', 'a', ...span(TUE, '09:00', '12:00')],
    ]);
    expect(rows.filter(r => r.deletedAt === null).every(r => r.liftId === 'lift-b')).toBe(true);
  });

  // guards: BR-CAL-020, BR-CAL-007
  it('початок у вихідний філії — один запис, продовження soft delete', async () => {
    const rows = chain();
    const { svc } = service(rows);

    await svc.updateSlot(ORG, 'a2', {
      liftId: 'lift-b',
      startAt: iso(SAT, '10:00'),
      endAt: iso(MON, '12:00'),
      chainSpan: true,
    });

    expect(liveChain(rows)).toEqual([['a', null, iso(SAT, '10:00'), iso(MON, '12:00')]]);
  });

  // guards: BR-CAL-020, BR-CAL-005
  it('зайнятість — без власних частин; чужий запис у наступний день → «зайнятий в один із наступних днів»', async () => {
    const rows = chain();
    const { svc } = service(rows);

    // Зсув на добу: нові частини перетинають старі власні — це не конфлікт.
    await svc.updateSlot(ORG, 'a', {
      startAt: iso(SAT, '16:00'),
      endAt: iso(MON, '10:00'),
      chainSpan: true,
    });
    expect(liveChain(rows)).toHaveLength(3);

    rows.push(
      fakeSlot({
        id: 'other',
        liftId: 'lift-1',
        startAt: kyiv(TUE, '09:00'),
        endAt: kyiv(TUE, '10:00'),
      }),
    );
    const before = structuredClone(rows);
    const next = await rejection(
      svc.updateSlot(ORG, 'a', {
        startAt: iso(SAT, '16:00'),
        endAt: iso(TUE, '12:00'),
        chainSpan: true,
      }),
    );
    expect((next as Error).message).toBe(msg('err.calendar.liftBusyNextDay'));
    expect(rows).toEqual(before);

    const first = await rejection(
      svc.updateSlot(ORG, 'a', {
        startAt: iso(TUE, '09:30'),
        endAt: iso(WED, '12:00'),
        chainSpan: true,
      }),
    );
    expect((first as Error).message).toBe(msg('err.calendar.liftBusy'));
  });

  // guards: BR-CAL-020, BR-CAL-006
  it('механік, зайнятий в один із днів ланцюжка → 400, і без зміни меж', async () => {
    const rows = [
      ...chain(),
      fakeSlot({
        id: 'm',
        liftId: 'lift-9',
        employeeId: 'mech-1',
        startAt: kyiv(SUN, '09:00'),
        endAt: kyiv(SUN, '09:30'),
      }),
    ];
    const before = structuredClone(rows);
    const { svc } = service(rows);

    const e = await rejection(svc.updateSlot(ORG, 'a2', { employeeId: 'mech-1' }));

    expect((e as Error).message).toBe(msg('err.calendar.employeeBusyNextDay'));
    expect(rows).toEqual(before);
  });

  // guards: BR-CAL-020
  it('поле без зміни меж — для всіх частин, без перебудови', async () => {
    const rows = chain();
    const { prisma, svc } = service(rows);

    await svc.updateSlot(ORG, 'a3', {
      notes: 'Нова примітка',
      counterpartyId: 'cp-1',
      employeeId: 'mech-2',
      startAt: iso(SUN, '08:00'),
      endAt: iso(SUN, '10:00'),
    });

    expect(rows.map(r => [r.id, r.notes, r.counterpartyId, r.employeeId, r.deletedAt])).toEqual([
      ['a', 'Нова примітка', 'cp-1', 'mech-2', null],
      ['a2', 'Нова примітка', 'cp-1', 'mech-2', null],
      ['a3', 'Нова примітка', 'cp-1', 'mech-2', null],
    ]);
    expect(prisma._create).not.toHaveBeenCalled();
    expect(liveChain(rows)).toEqual([
      ['a', null, ...span(FRI, '16:00', '20:00')],
      ['a2', 'a', ...span(SAT, '08:00', '20:00')],
      ['a3', 'a', ...span(SUN, '08:00', '10:00')],
    ]);
  });

  // guards: BR-CAL-020
  it('тенант: частина іншої організації з тим самим якорем не читається й не змінюється', async () => {
    const foreign = fakeSlot({
      id: 'x',
      orgId: 'org-2',
      liftId: 'lift-1',
      parentSlotId: 'a',
      startAt: kyiv(MON, '08:00'),
      endAt: kyiv(MON, '20:00'),
    });
    const rows = [...chain(), foreign];
    const { svc } = service(rows);

    // Подовження на 5 днів: чужа частина, прочитана як своя, отримала б день понеділка.
    const res = await svc.updateSlot(ORG, 'a', {
      startAt: iso(FRI, '16:00'),
      endAt: iso(TUE, '12:00'),
      chainSpan: true,
      notes: 'н',
    });

    expect(res.chainDays).toBe(5);
    expect(liveChain(rows).map(([, , start]) => start)).toEqual(
      [FRI, SAT, SUN, MON, TUE].map(d => iso(d, d === FRI ? '16:00' : '08:00')),
    );
    expect(rows.find(r => r.id === 'x')).toEqual(
      expect.objectContaining({ deletedAt: null, notes: null, startAt: kyiv(MON, '08:00') }),
    );
    await expect(svc.updateSlot('org-2', 'a', { notes: 'н' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // guards: BR-CAL-020, BR-CAL-006
  it('EXCLUDE-гонка при перебудові → 409 «підйомник зайнятий», а не 500', async () => {
    const { prisma, svc } = service(chain());
    const message =
      'conflicting key value violates exclusion constraint "calendar_slots_no_overlap"';
    prisma.$transaction = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error(message), { cause: { code: '23P01', message } }));

    const e = await rejection(
      svc.updateSlot(ORG, 'a', {
        startAt: iso(FRI, '16:00'),
        endAt: iso(MON, '12:00'),
        chainSpan: true,
      }),
    );

    expect(e).toBeInstanceOf(ConflictException);
    expect((e as Error).message).toBe(msg('err.calendar.liftBusy'));
  });

  // guards: BR-CAL-020
  it('відповідь календаря з будь-якого дня несе chainStartAt — початок першої частини', async () => {
    const { svc } = service(chain());

    const [sat] = await svc.findSlots(ORG, SAT, 'ADMIN');

    expect(sat).toMatchObject({
      id: 'a2',
      chainDays: 3,
      chainStartAt: iso(FRI, '16:00'),
      chainEndAt: iso(SUN, '10:00'),
    });
  });

  // guards: BR-CAL-020
  it('перевірка конфліктів із excludeSlotId частини — власні дні ланцюжка не конфлікт', async () => {
    const rows = [
      ...chain(),
      fakeSlot({
        id: 'other',
        liftId: 'lift-1',
        startAt: kyiv(MON, '09:00'),
        endAt: kyiv(MON, '10:00'),
      }),
    ];
    const { svc } = service(rows);

    const res = await svc.checkConflicts(ORG, {
      liftId: 'lift-1',
      startAt: iso(FRI, '16:00'),
      endAt: iso(MON, '12:00'),
      excludeSlotId: 'a3',
    });

    expect(res.conflictSlots.map(s => s.id)).toEqual(['other']);
  });

  // guards: BR-CAL-020, BR-WO-020
  it.each([
    [
      'перебудова: ланцюжок забрав наряд між читанням і транзакцією',
      { startAt: iso(FRI, '16:00'), endAt: iso(MON, '12:00'), chainSpan: true },
    ],
    ['примітка: ланцюжок забрав наряд між читанням і транзакцією', { notes: 'Нова' }],
  ])('%s → 400 «змінено паралельно», записи наряду не чіпаються (Bug #1064)', async (_l, dto) => {
    const rows = chain();
    const { prisma, svc } = service(rows);
    const run = prisma.$transaction.getMockImplementation()!;
    // Наряд, створений із цього запису (BR-WO-020), забрав ланцюжок у мить перед транзакцією.
    prisma.$transaction.mockImplementationOnce((cb: (tx: unknown) => unknown) => {
      for (const r of rows) r.workOrderId = 'wo-1';
      return run(cb);
    });
    const before = structuredClone(rows);

    const e = await rejection(svc.updateSlot(ORG, 'a2', dto));

    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe(msg('err.calendar.slotConcurrentChange'));
    expect(rows).toEqual(before.map(r => ({ ...r, workOrderId: 'wo-1' })));
  });

  // guards: BR-CAL-020
  it('паралельна перебудова додала частину між читанням і транзакцією → 400 «змінено паралельно» (Bug #1064)', async () => {
    const rows = chain();
    const { prisma, svc } = service(rows);
    const run = prisma.$transaction.getMockImplementation()!;
    prisma.$transaction.mockImplementationOnce((cb: (tx: unknown) => unknown) => {
      rows.push(
        fakeSlot({
          id: 'a4',
          liftId: 'lift-1',
          parentSlotId: 'a',
          startAt: kyiv(MON, '08:00'),
          endAt: kyiv(MON, '10:00'),
        }),
      );
      return run(cb);
    });

    const e = await rejection(
      svc.updateSlot(ORG, 'a', {
        startAt: iso(FRI, '16:00'),
        endAt: iso(SAT, '12:00'),
        chainSpan: true,
      }),
    );

    // Без перевірки перебудова на два дні лишила б чужу частину пн — «третій день» ланцюжка.
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe(msg('err.calendar.slotConcurrentChange'));
  });
});
