/**
 * BR-WO-019 — планові дати наряду не в минулому і в робочих годинах філії наряду (рішення
 * власника 2026-10-16). Плановий початок — `plannedAt`, планове завершення — `dueDate`.
 * Перевіряються лише значення, що змінюються відносно збережених: старий наряд із минулими
 * датами зберігається, якщо дат не чіпали. Київський час — з переведенням годинника.
 *
 * Правило — docs/objects/work-order.md, BR-WO-019.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { plannedDatesError } from './work-order-planned-dates';
import {
  BRANCH_NO_SETTINGS,
  NOW,
  WO_ID,
  ORG,
  createDto,
  kyiv,
  planningHarness,
  woRow,
} from './work-orders.planning.spec-fixture';

const H = { startHour: 8, endHour: 18 };
const D = '2026-05-22';
const IN_PAST = translateError('err.workOrder.plannedInPast', 'uk');
const OUTSIDE_8_18 = translateError('err.workOrder.plannedOutsideWorkHours', 'uk', {
  start: '08',
  end: '18',
});
const END_BEFORE = translateError('err.workOrder.plannedEndBeforeStart', 'uk');

const next = (plannedAt: Date | null, dueDate: Date | null) => ({ plannedAt, dueDate });

async function rejection(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BadRequestException);
  return err as Error;
}

describe('plannedDatesError — правило BR-WO-019', () => {
  // guards: BR-WO-019
  it.each([
    ['початок у минулому', next(kyiv('2026-05-19', '10:00'), null)],
    ['завершення в минулому', next(null, kyiv('2026-05-20', '08:30'))],
    ['початок на хвилину раніше «зараз»', next(new Date(NOW.getTime() - 60_000), null)],
  ])('%s → «в минулому»', (_l, n) => {
    expect(plannedDatesError(n, null, NOW, H)).toEqual({ key: 'err.workOrder.plannedInPast' });
  });

  // guards: BR-WO-019
  it('рівно «зараз» — ще не минуле', () => {
    expect(plannedDatesError(next(NOW, null), null, NOW, H)).toBeNull();
  });

  // guards: BR-WO-019
  it.each([
    ['початок до відкриття (07:30)', next(kyiv(D, '07:30'), null)],
    ['початок о закритті (18:00) — працювати вже ніколи', next(kyiv(D, '18:00'), null)],
    ['завершення після закриття (18:15)', next(null, kyiv(D, '18:15'))],
    ['завершення до відкриття (07:45)', next(null, kyiv(D, '07:45'))],
  ])('%s → «поза робочими годинами» з годинами філії', (_l, n) => {
    expect(plannedDatesError(n, null, NOW, H)).toEqual({
      key: 'err.workOrder.plannedOutsideWorkHours',
      params: { start: '08', end: '18' },
    });
  });

  // guards: BR-WO-019
  it('межі вікна: початок о 08:00 і завершення о 18:00 — дозволені', () => {
    expect(plannedDatesError(next(kyiv(D, '08:00'), kyiv(D, '18:00')), null, NOW, H)).toBeNull();
  });

  // guards: BR-WO-019
  it.each([
    ['завершення раніше за початок', next(kyiv(D, '12:00'), kyiv(D, '11:00'))],
    ['завершення дорівнює початку', next(kyiv(D, '12:00'), kyiv(D, '12:00'))],
  ])('%s → «завершення пізніше за початок»', (_l, n) => {
    expect(plannedDatesError(n, null, NOW, H)).toEqual({
      key: 'err.workOrder.plannedEndBeforeStart',
    });
  });

  // guards: BR-WO-019
  it('незмінені старі дати (минулі, поза годинами) не перевіряються', () => {
    const old = next(kyiv('2026-05-01', '07:00'), kyiv('2026-05-01', '19:00'));
    expect(plannedDatesError(old, old, NOW, H)).toBeNull();
  });

  // guards: BR-WO-019
  it('змінено лише завершення: старий минулий початок не заважає, нове завершення перевіряється', () => {
    const prev = next(kyiv('2026-05-01', '10:00'), kyiv('2026-05-01', '12:00'));
    expect(plannedDatesError(next(prev.plannedAt, kyiv(D, '12:00')), prev, NOW, H)).toBeNull();
    expect(plannedDatesError(next(prev.plannedAt, kyiv(D, '19:00')), prev, NOW, H)).toEqual({
      key: 'err.workOrder.plannedOutsideWorkHours',
      params: { start: '08', end: '18' },
    });
  });

  // guards: BR-WO-019
  it('Київ, зимовий час (+02 після 25.10): 05:30Z — 07:30, поза вікном; 16:00Z — рівно 18:00', () => {
    const now = new Date('2026-10-20T06:00:00Z');
    // Зсув «+03» усе літо зробив би з 05:30Z 08:30 — у вікні; з 16:00Z — 19:00, поза вікном.
    expect(plannedDatesError(next(new Date('2026-10-26T05:30:00Z'), null), null, now, H)).toEqual(
      expect.objectContaining({ key: 'err.workOrder.plannedOutsideWorkHours' }),
    );
    expect(
      plannedDatesError(next(null, new Date('2026-10-26T16:00:00Z')), null, now, H),
    ).toBeNull();
  });
});

describe('WorkOrdersService — BR-WO-019 при створенні й зміні наряду', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-WO-019
  it('create з минулим початком → 400 «в минулому»; номер не взято, наряд не створено', async () => {
    const h = planningHarness({ workOrders: [] });
    const err = await rejection(
      h.service.create(
        ORG,
        createDto({
          plannedAt: kyiv('2026-05-19', '10:00').toISOString(),
          dueDate: kyiv(D, '12:00').toISOString(),
        }),
      ),
    );
    expect(err.message).toBe(IN_PAST);
    expect(h.docNumbers.next).not.toHaveBeenCalled();
    expect(h.workOrder.rows).toHaveLength(0);
  });

  // guards: BR-WO-019
  it('create поза годинами філії (08–18) → 400 з годинами саме цієї філії', async () => {
    const h = planningHarness({ workOrders: [] });
    const err = await rejection(
      h.service.create(ORG, createDto({ plannedAt: kyiv(D, '07:00').toISOString() })),
    );
    expect(err.message).toBe(OUTSIDE_8_18);
    expect(err.message).toBe('Плановий час має бути в робочих годинах (08:00–18:00)');
    expect(h.workOrder.rows).toHaveLength(0);
  });

  // guards: BR-WO-019
  it('філія без налаштувань → типові 09–18: 08:30 відхилено з «09:00–18:00»', async () => {
    const h = planningHarness({ workOrders: [] });
    const err = await rejection(
      h.service.create(
        ORG,
        createDto({ branchId: BRANCH_NO_SETTINGS, plannedAt: kyiv(D, '08:30').toISOString() }),
      ),
    );
    expect(err.message).toBe('Плановий час має бути в робочих годинах (09:00–18:00)');
  });

  // guards: BR-WO-019
  it('create: завершення раніше за початок → 400', async () => {
    const h = planningHarness({ workOrders: [] });
    const err = await rejection(
      h.service.create(
        ORG,
        createDto({
          plannedAt: kyiv(D, '12:00').toISOString(),
          dueDate: kyiv(D, '11:00').toISOString(),
        }),
      ),
    );
    expect(err.message).toBe(END_BEFORE);
  });

  // guards: BR-WO-019
  it('update: нове завершення поза годинами → 400, наряд не змінено', async () => {
    const h = planningHarness();
    const err = await rejection(
      h.service.update(ORG, WO_ID, {
        plannedAt: kyiv(D, '10:00').toISOString(),
        dueDate: kyiv(D, '19:00').toISOString(),
      }),
    );
    expect(err.message).toBe(OUTSIDE_8_18);
    expect(h.workOrder.update).not.toHaveBeenCalled();
    expect(h.workOrder.rows[0]!.plannedAt).toBeNull();
  });

  // guards: BR-WO-019
  it('update старого наряду з минулими датами, що форма шле без змін, → зберігається', async () => {
    const plannedAt = kyiv('2026-05-01', '07:00'); // і минуле, і поза годинами
    const dueDate = kyiv('2026-05-01', '19:00');
    const h = planningHarness({ workOrders: [woRow({ plannedAt, dueDate })] });
    await h.service.update(ORG, WO_ID, {
      description: 'новий опис',
      plannedAt: plannedAt.toISOString(),
      dueDate: dueDate.toISOString(),
    });
    expect(h.workOrder.rows[0]!.description).toBe('новий опис');
    expect((h.workOrder.rows[0]!.plannedAt as Date).getTime()).toBe(plannedAt.getTime());
  });

  // guards: BR-WO-019
  it('clone не копіює планові дати оригіналу (минулі) — клон без дат і без запису календаря', async () => {
    const h = planningHarness({
      workOrders: [
        woRow({
          plannedAt: kyiv('2026-05-01', '10:00'),
          dueDate: kyiv('2026-05-01', '12:00'),
          plannedHours: 2,
        }),
      ],
    });
    const cloned = await h.service.clone(ORG, WO_ID, 'user-1');
    const row = h.workOrder.rows.find(w => w.id === cloned.id)!;
    expect(row.plannedAt).toBeNull();
    expect(row.dueDate).toBeNull();
    expect(row.plannedHours).toBe(2);
    expect(h.calendarSlot.rows).toHaveLength(0);
  });

  // guards: BR-WO-019
  it('фактичні поля й дата документа BR-WO-019 не перевіряє: минула дата документа — ок', async () => {
    const h = planningHarness();
    await h.service.update(ORG, WO_ID, { documentDate: '2026-01-05', actualHours: 3 });
    expect(h.workOrder.rows[0]!.actualHours).toBe(3);
  });
});
