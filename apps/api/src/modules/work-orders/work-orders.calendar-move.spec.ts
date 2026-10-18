/**
 * BR-WO-023 — перетягування запису наряду в календарі змінює дати наряду (рішення власника
 * 2026-10-18). Будь-який запис ланцюжка зсуває планові початок і завершення наряду на ту саму
 * різницю (тривалість зберігається), рядок іншого підйомника змінює підйомник наряду. Нові дати
 * проходять BR-WO-019 (не в минулому, робочі години філії) і BR-WO-020 (зайнятість підйомника й
 * механіка, поділ на дні), механік — за BR-CAL-012 (знімається з причиною). Відмова — 400, ні
 * наряд, ні записи не змінюються.
 *
 * Справжні WorkOrdersService + CalendarService над таблицями в пам'яті
 * (`work-orders.planning.spec-fixture.ts`; `$transaction` відкочує таблиці при винятку).
 * «Зараз» — 20.05.2026 09:00 Києва; філія 08:00–18:00.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  BadRequestException,
  NotFoundException,
  ValidationPipe,
  type ExecutionContext,
} from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { translateError } from '@sto/shared';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { PrismaService } from '../../prisma/prisma.service';
import { LinesSummaryService } from '../lines-summary/lines-summary.service';
import { WorkOrderShareService } from './work-order-share.service';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersService } from './work-orders.service';
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
  kyiv,
  planningHarness,
  slotRow,
  woRow,
} from './work-orders.planning.spec-fixture';

const D = '2026-05-22';
const D2 = '2026-05-23';
const t = (d: unknown) => (d as Date).getTime();

/** Наряд WO_ID (D 10:00–12:00 на LIFT_1) з якорем у календарі. */
function planned(
  woOver: Record<string, unknown> = {},
  slotOver: Record<string, unknown> = {},
  extra: Record<string, unknown>[] = [],
) {
  return planningHarness({
    workOrders: [
      woRow({ liftId: LIFT_1, plannedAt: kyiv(D, '10:00'), dueDate: kyiv(D, '12:00'), ...woOver }),
      woRow({ id: OTHER_WO, number: 'НРД-9', status: 'APPROVED' }),
    ],
    slots: [slotRow('anchor', slotOver), ...(extra as never[])],
  });
}

type Harness = ReturnType<typeof planningHarness>;
const wo = (h: Harness) => h.workOrder.rows.find(w => w.id === WO_ID)!;
const snapshot = (h: Harness) => structuredClone([wo(h), h.calendarSlot.rows]);

async function rejected(h: Harness, p: Promise<unknown>, ErrorType = BadRequestException) {
  const before = snapshot(h);
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ErrorType);
  // Ні наряд, ні записи не змінились.
  expect(snapshot(h)).toEqual(before);
  return err as Error;
}

describe('WorkOrdersService.reschedule — перетягування запису наряду (BR-WO-023)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-WO-023
  it('запис +2 год на тому самому підйомнику → наряд 12:00–14:00, тривалість та сама, той самий запис', async () => {
    const h = planned();

    const res = await h.service.reschedule(ORG, WO_ID, {
      slotId: 'anchor',
      startAt: kyiv(D, '12:00').toISOString(),
      liftId: LIFT_1,
    });

    expect(t(wo(h).plannedAt)).toBe(t(kyiv(D, '12:00')));
    expect(t(wo(h).dueDate)).toBe(t(kyiv(D, '14:00')));
    expect(res).toMatchObject({ id: WO_ID, liftId: LIFT_1 });
    expect(res).not.toHaveProperty('mechanicDropped');
    const live = h.liveSlots();
    expect(live.map(s => s.id)).toEqual(['anchor']);
    expect(t(live[0]!.startAt)).toBe(t(kyiv(D, '12:00')));
    expect(t(live[0]!.endAt)).toBe(t(kyiv(D, '14:00')));
  });

  // guards: BR-WO-023
  it('рядок іншого підйомника → підйомник наряду змінено, механік, закріплений за обома, лишається', async () => {
    const h = planned({}, { employeeId: MECH_BOTH });

    const res = await h.service.reschedule(ORG, WO_ID, {
      slotId: 'anchor',
      startAt: kyiv(D, '10:00').toISOString(),
      liftId: LIFT_2,
    });

    expect(wo(h).liftId).toBe(LIFT_2);
    expect(res.liftId).toBe(LIFT_2);
    expect(h.liveSlots()).toEqual([
      expect.objectContaining({ id: 'anchor', liftId: LIFT_2, employeeId: MECH_BOTH }),
    ]);
    expect(t(wo(h).plannedAt)).toBe(t(kyiv(D, '10:00')));
  });

  // guards: BR-WO-023
  it('механік не закріплений за новим підйомником → знятий, у відповіді причина (BR-CAL-012)', async () => {
    const h = planned({}, { employeeId: MECH_1 });

    const res = await h.service.reschedule(ORG, WO_ID, {
      slotId: 'anchor',
      startAt: kyiv(D, '10:00').toISOString(),
      liftId: LIFT_2,
    });

    expect(res).toMatchObject({ mechanicDropped: true, mechanicDroppedReason: 'NOT_ON_LIFT' });
    expect(h.liveSlots()[0]).toMatchObject({ liftId: LIFT_2, employeeId: null });
  });

  // guards: BR-WO-023
  it('перетягнуто продовження багатоденного → зсувається весь ланцюжок і наряд', async () => {
    const h = planningHarness({
      workOrders: [
        woRow({ liftId: LIFT_1, plannedAt: kyiv(D, '16:00'), dueDate: kyiv(D2, '10:00') }),
      ],
      slots: [
        slotRow('anchor', { startAt: kyiv(D, '16:00'), endAt: kyiv(D, '18:00') }),
        slotRow('cont', {
          parentSlotId: 'anchor',
          startAt: kyiv(D2, '08:00'),
          endAt: kyiv(D2, '10:00'),
        }),
      ],
    });

    await h.service.reschedule(ORG, WO_ID, {
      slotId: 'cont',
      startAt: kyiv(D2, '09:00').toISOString(),
      liftId: LIFT_1,
    });

    expect(t(wo(h).plannedAt)).toBe(t(kyiv(D, '17:00')));
    expect(t(wo(h).dueDate)).toBe(t(kyiv(D2, '11:00')));
    const live = h.liveSlots().sort((a, b) => t(a.startAt) - t(b.startAt));
    expect(live.map(s => [t(s.startAt), t(s.endAt)])).toEqual([
      [t(kyiv(D, '17:00')), t(kyiv(D, '18:00'))],
      [t(kyiv(D2, '08:00')), t(kyiv(D2, '11:00'))],
    ]);
    expect(live[0]!.id).toBe('anchor');
    expect(live[1]!.parentSlotId).toBe('anchor');
  });

  // guards: BR-WO-023
  it('наряд без планових дат (запис прив’язано формою) → наряд отримує дати перетягнутого запису', async () => {
    const h = planned(
      { plannedAt: null, dueDate: null },
      { startAt: kyiv(D, '10:00'), endAt: kyiv(D, '11:00') },
    );

    await h.service.reschedule(ORG, WO_ID, {
      slotId: 'anchor',
      startAt: kyiv(D, '13:00').toISOString(),
      liftId: LIFT_1,
    });

    expect(t(wo(h).plannedAt)).toBe(t(kyiv(D, '13:00')));
    expect(t(wo(h).dueDate)).toBe(t(kyiv(D, '14:00')));
    expect(h.liveSlots().map(s => s.id)).toEqual(['anchor']);
  });

  // guards: BR-WO-023
  it('у минуле → 400 «в минулому» (BR-WO-019), наряд і запис не змінено', async () => {
    const h = planned(
      { plannedAt: kyiv('2026-05-20', '10:00'), dueDate: kyiv('2026-05-20', '11:00') },
      {
        startAt: kyiv('2026-05-20', '10:00'),
        endAt: kyiv('2026-05-20', '11:00'),
      },
    );

    const err = await rejected(
      h,
      h.service.reschedule(ORG, WO_ID, {
        slotId: 'anchor',
        startAt: kyiv('2026-05-20', '08:00').toISOString(),
        liftId: LIFT_1,
      }),
    );
    expect(err.message).toBe(translateError('err.workOrder.plannedInPast', 'uk'));
  });

  // guards: BR-WO-023
  it('за межі робочих годин філії → 400 з годинами філії, без змін', async () => {
    const h = planned();

    const err = await rejected(
      h,
      h.service.reschedule(ORG, WO_ID, {
        slotId: 'anchor',
        startAt: kyiv(D, '17:00').toISOString(),
        liftId: LIFT_1,
      }),
    );
    expect(err.message).toContain('08:00');
  });

  // guards: BR-WO-023
  it('підйомник зайнятий іншим записом → 400 «зайнятий», без змін', async () => {
    const h = planned({}, {}, [
      slotRow('busy', {
        workOrderId: null,
        liftId: LIFT_2,
        startAt: kyiv(D, '10:30'),
        endAt: kyiv(D, '11:30'),
      }),
    ]);

    const err = await rejected(
      h,
      h.service.reschedule(ORG, WO_ID, {
        slotId: 'anchor',
        startAt: kyiv(D, '10:00').toISOString(),
        liftId: LIFT_2,
      }),
    );
    expect(err.message).toBe(translateError('err.calendar.liftBusy', 'uk'));
  });

  // guards: BR-WO-023
  it('механік зайнятий у новий час → 400, без змін', async () => {
    const h = planned({}, { employeeId: MECH_BOTH }, [
      slotRow('mech-busy', {
        workOrderId: OTHER_WO,
        liftId: LIFT_2,
        employeeId: MECH_BOTH,
        startAt: kyiv(D, '14:00'),
        endAt: kyiv(D, '15:00'),
      }),
    ]);

    const err = await rejected(
      h,
      h.service.reschedule(ORG, WO_ID, {
        slotId: 'anchor',
        startAt: kyiv(D, '13:00').toISOString(),
        liftId: LIFT_1,
      }),
    );
    expect(err.message).toBe(translateError('err.calendar.employeeBusy', 'uk'));
  });

  // guards: BR-WO-023
  it('закритий наряд (виконаний) → 400, без змін', async () => {
    const h = planned({ status: 'COMPLETED' });

    await rejected(
      h,
      h.service.reschedule(ORG, WO_ID, {
        slotId: 'anchor',
        startAt: kyiv(D, '12:00').toISOString(),
        liftId: LIFT_1,
      }),
    );
  });

  // guards: BR-WO-023
  it.each([
    ['запис іншого наряду', slotRow('foreign-wo', { workOrderId: OTHER_WO, liftId: LIFT_2 })],
    ['запис чужої організації', slotRow('foreign-org', { orgId: OTHER_ORG, liftId: LIFT_2 })],
    ['видалений запис', slotRow('gone', { deletedAt: new Date('2026-05-01'), liftId: LIFT_2 })],
  ])('%s → 404, без змін', async (_label, row) => {
    const h = planned({}, {}, [row]);

    await rejected(
      h,
      h.service.reschedule(ORG, WO_ID, {
        slotId: row.id as string,
        startAt: kyiv(D, '12:00').toISOString(),
        liftId: LIFT_1,
      }),
      NotFoundException,
    );
  });
});

// HTTP: ролі — СПРАВЖНІЙ RolesGuard з `@Roles` контролера (ті самі, що змінюють наряд і записи
// календаря, BR-CAL-010); тіло — ValidationPipe; сервіс — справжній над таблицями в пам'яті.
describe('PATCH /work-orders/:id/reschedule — ролі й тіло (BR-WO-023)', () => {
  let app: NestFastifyApplication;
  let role = 'RECEPTIONIST';
  let h: Harness;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WorkOrdersController],
      providers: [
        {
          provide: WorkOrdersService,
          useValue: {
            reschedule: (...args: Parameters<WorkOrdersService['reschedule']>) =>
              h.service.reschedule(...args),
          },
        },
        { provide: WorkOrderShareService, useValue: {} },
        { provide: LinesSummaryService, useValue: {} },
        { provide: PrismaService, useValue: {} },
        IdempotencyInterceptor,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user: unknown }>().user = { id: 'u-1', orgId: ORG, role };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    h = planned();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const SLOT = '81111111-1111-4111-8111-111111111111';
  const send = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/work-orders/${WO_ID}/reschedule`, payload });

  // guards: BR-WO-023
  it.each(['MECHANIC', 'STOREKEEPER', 'ACCOUNTANT'])('%s → 403, наряд не змінено', async r => {
    role = r;
    h = planned({}, { id: SLOT });
    const res = await send({ slotId: SLOT, startAt: kyiv(D, '12:00').toISOString() });
    expect(res.statusCode).toBe(403);
    expect(t(wo(h).plannedAt)).toBe(t(kyiv(D, '10:00')));
  });

  // guards: BR-WO-023
  it('приймальня → 200, наряд перенесено', async () => {
    role = 'RECEPTIONIST';
    h = planned({}, { id: SLOT });
    const res = await send({
      slotId: SLOT,
      startAt: kyiv(D, '12:00').toISOString(),
      liftId: LIFT_1,
    });
    expect(res.statusCode).toBe(200);
    expect(t(wo(h).plannedAt)).toBe(t(kyiv(D, '12:00')));
  });

  it.each([
    [{ slotId: 'not-a-uuid', startAt: '2026-05-22T09:00:00.000Z' }],
    [{ slotId: '81111111-1111-4111-8111-111111111111', startAt: 'завтра' }],
    [
      {
        slotId: '81111111-1111-4111-8111-111111111111',
        startAt: '2026-05-22T09:00:00.000Z',
        liftId: 'x',
      },
    ],
  ])('некоректне тіло %j → 400', async payload => {
    role = 'ADMIN';
    const res = await send(payload);
    expect(res.statusCode).toBe(400);
  });
});
