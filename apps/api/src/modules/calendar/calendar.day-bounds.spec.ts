/**
 * CalendarService.findSlots — межі дня календаря.
 *
 * День календаря — КИЇВСЬКА доба: від 00:00:00.000 до 23:59:59.999 за київським часом. Раніше
 * обидві межі рахувались зсувом ПОЛУДНЯ, тож у день переведення годинника північ отримувала
 * чужий зсув: 29.03.2026 день починався о 23:00 попереднього (зайва година 28.03 у відборі),
 * 25.10.2026 — о 01:00 (перша година доби випадала). Тепер зсув кожної межі береться окремо.
 *
 * Частина кейсів дивиться на межі у `where`, частина ВИКОНУЄ `where` над слотами у пам'яті
 * (`buildSlotStorePrisma`): так тест описує поведінку («нічний слот 25.10 видно»), а не форму.
 *
 * Mutation-verify: повернути зсув полудня на обидві межі
 * (`start = 00:00Z − offset(12:00Z)`, `end = 23:59:59.999Z − offset(12:00Z)`) → падають кейси
 * 29.03 і 25.10 (межі й обидва поведінкові); замінити `isCalendarDate(date)` на перевірку
 * лише форми → падає `2026-02-31`.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import {
  FAKE_ORG_ID,
  buildSlotStorePrisma,
  fakeSlot,
  type FakeSlot,
} from './calendar.spec-fixture';

function makeSpyService() {
  const findMany = vi.fn().mockResolvedValue([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new CalendarService({ calendarSlot: { findMany } } as any);
  return { service, findMany };
}

function makeStoreService(rows: FakeSlot[]) {
  const prisma = buildSlotStorePrisma(rows);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new CalendarService(prisma as any);
}

/** Межі дня, з якими викликано Prisma: слот перетинає [start, end) ⇔ startAt < end і endAt > start. */
async function dayBounds(date: string, role = 'ADMIN') {
  const { service, findMany } = makeSpyService();
  await service.findSlots(FAKE_ORG_ID, date, role);
  expect(findMany).toHaveBeenCalledTimes(1);
  const where = findMany.mock.calls[0][0].where as {
    orgId: string;
    startAt: { lt: Date };
    endAt: { gt: Date };
  };
  return { start: where.endAt.gt.toISOString(), end: where.startAt.lt.toISOString(), where };
}

describe('CalendarService.findSlots — межі київської доби', () => {
  it('літо (UTC+3): 15.06 — від 14.06 21:00Z до 15.06 20:59:59.999Z', async () => {
    const { start, end, where } = await dayBounds('2026-06-15');
    expect(start).toBe('2026-06-14T21:00:00.000Z');
    expect(end).toBe('2026-06-15T20:59:59.999Z');
    expect(where.orgId).toBe(FAKE_ORG_ID);
  });

  it('зима (UTC+2): 15.01 — від 14.01 22:00Z до 15.01 21:59:59.999Z', async () => {
    const { start, end } = await dayBounds('2026-01-15');
    expect(start).toBe('2026-01-14T22:00:00.000Z');
    expect(end).toBe('2026-01-15T21:59:59.999Z');
  });

  it('29.03.2026 (перехід на літній час): день починається о київській півночі за ЗИМОВИМ зсувом — 28.03 22:00Z, а не 21:00Z', async () => {
    const { start, end } = await dayBounds('2026-03-29');
    expect(start).toBe('2026-03-28T22:00:00.000Z');
    expect(end).toBe('2026-03-29T20:59:59.999Z');
  });

  it('25.10.2026 (перехід на зимовий час): день починається о київській півночі за ЛІТНІМ зсувом — 24.10 21:00Z, а не 22:00Z', async () => {
    const { start, end } = await dayBounds('2026-10-25');
    expect(start).toBe('2026-10-24T21:00:00.000Z');
    expect(end).toBe('2026-10-25T21:59:59.999Z');
  });

  it('гілка механіка отримує ті самі межі дня переведення годинника', async () => {
    const { start, end } = await dayBounds('2026-10-25', 'MECHANIC');
    expect(start).toBe('2026-10-24T21:00:00.000Z');
    expect(end).toBe('2026-10-25T21:59:59.999Z');
  });

  it('сусідні дні довкола переходу стикуються без проміжку й без перетину', async () => {
    for (const [day, next] of [
      ['2026-03-28', '2026-03-29'],
      ['2026-03-29', '2026-03-30'],
      ['2026-10-24', '2026-10-25'],
      ['2026-10-25', '2026-10-26'],
    ] as const) {
      const a = await dayBounds(day);
      const b = await dayBounds(next);
      expect(new Date(b.start).getTime() - new Date(a.end).getTime()).toBe(1);
    }
  });

  it('25.10.2026: слот 00:10–00:50 за Києвом (перша година доби) видно в цьому дні й не видно у 24.10', async () => {
    const night = fakeSlot({
      startAt: new Date('2026-10-24T21:10:00.000Z'),
      endAt: new Date('2026-10-24T21:50:00.000Z'),
    });
    const service = makeStoreService([night]);

    const on25 = await service.findSlots(FAKE_ORG_ID, '2026-10-25', 'ADMIN');
    const on24 = await service.findSlots(FAKE_ORG_ID, '2026-10-24', 'ADMIN');

    expect(on25.map(s => s.id)).toEqual([night.id]);
    expect(on24).toEqual([]);
  });

  it('29.03.2026: слот 23:10–23:50 за Києвом 28.03 лишається у 28.03 і не потрапляє у 29.03', async () => {
    const lateEvening = fakeSlot({
      startAt: new Date('2026-03-28T21:10:00.000Z'),
      endAt: new Date('2026-03-28T21:50:00.000Z'),
    });
    const service = makeStoreService([lateEvening]);

    const on28 = await service.findSlots(FAKE_ORG_ID, '2026-03-28', 'ADMIN');
    const on29 = await service.findSlots(FAKE_ORG_ID, '2026-03-29', 'ADMIN');

    expect(on28.map(s => s.id)).toEqual([lateEvening.id]);
    expect(on29).toEqual([]);
  });

  it('слот чужої організації у день не потрапляє', async () => {
    const foreign = fakeSlot({
      orgId: 'org-2',
      startAt: new Date('2026-06-15T07:00:00.000Z'),
      endAt: new Date('2026-06-15T08:00:00.000Z'),
    });
    const service = makeStoreService([foreign]);
    expect(await service.findSlots(FAKE_ORG_ID, '2026-06-15', 'ADMIN')).toEqual([]);
  });
});

describe('CalendarService.findSlots — перевірка дати', () => {
  it.each(['2026-02-31', '2026-13-01', '2025-02-29', '0000-01-01'])(
    'неіснуюча дата %s → 400, запит до бази не йде',
    async date => {
      const { service, findMany } = makeSpyService();
      await expect(service.findSlots(FAKE_ORG_ID, date, 'ADMIN')).rejects.toThrow(
        BadRequestException,
      );
      expect(findMany).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'abc', '2026-06-15T10:00:00Z', '15.06.2026'])(
    'не формат РРРР-ММ-ДД («%s») → 400 з текстом про формат',
    async date => {
      const { service, findMany } = makeSpyService();
      await expect(service.findSlots(FAKE_ORG_ID, date, 'ADMIN')).rejects.toThrow(
        /Невірний формат дати/,
      );
      expect(findMany).not.toHaveBeenCalled();
    },
  );

  it('29 лютого високосного року — існуюча дата, проходить', async () => {
    const { start, end } = await dayBounds('2024-02-29');
    expect(start).toBe('2024-02-28T22:00:00.000Z');
    expect(end).toBe('2024-02-29T21:59:59.999Z');
  });
});
