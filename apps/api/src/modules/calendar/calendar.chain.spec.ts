/**
 * Ланцюжок запису в відповіді календаря (BR-CAL-019; рішення власника 2026-10-30 / 2026-11-06,
 * TECH-DEBT (б) №60, №66): кожен запис віддає `chainDays` — кількість живих частин ланцюжка
 * (якір і продовження), частиною якого він є, — і `chainEndAt`, кінець останньої частини. Web за
 * ними питає «Видалити всі N днів?» і знає, чи це останній день, не вгадуючи наступний день.
 *
 * Сховище в пам'яті (`calendar.spec-fixture.ts`) справді обчислює `where`: запит ланцюжків
 * перевіряється поведінкою (видалена частина не рахується, чужий ланцюжок не змішується), а не
 * формою запиту. 22.05.2026 — пт, +03:00.
 */
import { describe, it, expect } from 'vitest';
import { CalendarService } from './calendar.service';
import {
  buildSlotStorePrisma,
  fakeSlot,
  matchesWhere as matches,
  type FakeSlot,
} from './calendar.spec-fixture';

const kyiv = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+03:00`);

/** Ручний запис на три дні (пт 16–20, сб 08–20, нд 08–10) і окремий одноденний запис. */
function threeDayChain(): FakeSlot[] {
  const anchor = fakeSlot({
    id: 'a',
    liftId: 'lift-1',
    startAt: kyiv('2026-05-22', '16:00'),
    endAt: kyiv('2026-05-22', '20:00'),
  });
  return [
    anchor,
    fakeSlot({
      id: 'a2',
      liftId: 'lift-1',
      parentSlotId: 'a',
      startAt: kyiv('2026-05-23', '08:00'),
      endAt: kyiv('2026-05-23', '20:00'),
    }),
    fakeSlot({
      id: 'a3',
      liftId: 'lift-1',
      parentSlotId: 'a',
      startAt: kyiv('2026-05-24', '08:00'),
      endAt: kyiv('2026-05-24', '10:00'),
    }),
    fakeSlot({
      id: 'single',
      liftId: 'lift-2',
      startAt: kyiv('2026-05-23', '09:00'),
      endAt: kyiv('2026-05-23', '11:00'),
    }),
  ];
}

function service(rows: FakeSlot[]) {
  const prisma = buildSlotStorePrisma(rows);
  return { prisma, svc: new CalendarService(prisma as never) };
}

const chainOf = (slots: { id: string; chainDays: number; chainEndAt: string }[]) =>
  Object.fromEntries(slots.map(s => [s.id, [s.chainDays, s.chainEndAt]]));

describe('Ланцюжок запису у відповіді календаря (BR-CAL-019)', () => {
  // guards: BR-CAL-019
  it('день другої частини: видно лише продовження — воно знає всі 3 дні й кінець неділі', async () => {
    const { svc } = service(threeDayChain());

    const day = await svc.findSlots('org-1', '2026-05-23', 'ADMIN');

    expect(chainOf(day)).toEqual({
      a2: [3, kyiv('2026-05-24', '10:00').toISOString()],
      single: [1, kyiv('2026-05-23', '11:00').toISOString()],
    });
  });

  // guards: BR-CAL-019
  it('діапазон: усі частини одного ланцюжка — однакові chainDays і chainEndAt; механік — так само', async () => {
    const { svc } = service(threeDayChain());

    const range = await svc.findSlotsInRange('org-1', '2026-05-22', '2026-05-24', 'ADMIN');
    const mechanic = await svc.findSlotsInRange('org-1', '2026-05-22', '2026-05-24', 'MECHANIC');

    const end = kyiv('2026-05-24', '10:00').toISOString();
    const expected = {
      a: [3, end],
      a2: [3, end],
      a3: [3, end],
      single: [1, kyiv('2026-05-23', '11:00').toISOString()],
    };
    expect(chainOf(range)).toEqual(expected);
    expect(chainOf(mechanic)).toEqual(expected);
  });

  // guards: BR-CAL-019
  it('видалена частина не рахується: без неділі ланцюжок — 2 дні до суботи 20:00', async () => {
    const rows = threeDayChain();
    rows.find(r => r.id === 'a3')!.deletedAt = new Date();
    const { svc } = service(rows);

    const day = await svc.findSlots('org-1', '2026-05-22', 'ADMIN');

    expect(chainOf(day)).toEqual({ a: [2, kyiv('2026-05-23', '20:00').toISOString()] });
  });

  // guards: BR-CAL-019
  it('ланцюжки всієї відповіді — одним запитом, не на кожен запис', async () => {
    const { svc, prisma } = service(threeDayChain());

    await svc.findSlotsInRange('org-1', '2026-05-22', '2026-05-24', 'ADMIN');

    // Записи діапазону + ланцюжки — два запити на 4 записи.
    expect(prisma.calendarSlot.findMany).toHaveBeenCalledTimes(2);
  });

  // guards: BR-CAL-019
  it('removeSlot продовження → позначено видаленими всі частини ланцюжка, інший запис цілий', async () => {
    const rows = threeDayChain();
    const store = buildSlotStorePrisma(rows);
    const prisma = {
      ...store,
      calendarSlot: {
        ...store.calendarSlot,
        updateMany: ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Partial<FakeSlot>;
        }) => {
          const hit = rows.filter(r => matches(r, where));
          hit.forEach(r => Object.assign(r, data));
          return Promise.resolve({ count: hit.length });
        },
      },
    };
    const svc = new CalendarService(prisma as never);

    await svc.removeSlot('org-1', 'a3');

    expect(rows.map(r => [r.id, r.deletedAt !== null])).toEqual([
      ['a', true],
      ['a2', true],
      ['a3', true],
      ['single', false],
    ]);
  });
});
