/**
 * BR-WO-017 — видалення наряду звільняє календар (рішення власника 2026-10-16): soft delete наряду
 * у тій самій транзакції позначає видаленими (`deletedAt`) усі його записи календаря — обидві
 * частини багатоденного; підйомник і механік звільняються.
 *
 * Наряд і записи календаря — таблиці в пам'яті (`memoryTable`): `where` виконується по-справжньому,
 * тож тест бачить, ЯКІ записи позначено, а не форму запиту. Транзакція віддає колбеку власні
 * делегати (`tx`), а кореневий `prisma.calendarSlot` кидає — запис поза транзакцією впав би.
 */
import { describe, it, expect, vi } from 'vitest';
import { WorkOrdersService } from './work-orders.service';
import { memoryTable, type MemRow } from '../cash/cash.spec-fixture';
import type { PrismaService } from '../../prisma/prisma.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '11111111-1111-4111-8111-999999999999';
const WO_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_WO = '22222222-2222-4222-8222-333333333333';
const EARLIER = new Date('2026-09-01T10:00:00Z');

function slot(id: string, over: MemRow = {}): MemRow {
  return {
    id,
    orgId: ORG,
    workOrderId: WO_ID,
    parentSlotId: null,
    liftId: 'lift-1',
    employeeId: 'mech-1',
    deletedAt: null,
    ...over,
  };
}

function harness(woOver: MemRow = {}, slots: MemRow[] = []) {
  const workOrder = memoryTable([
    {
      id: WO_ID,
      orgId: ORG,
      number: 'НРД-7',
      status: 'DRAFT',
      paidAmount: 0,
      deletedAt: null,
      ...woOver,
    },
  ]);
  const calendarSlot = memoryTable(slots);
  const tx = { workOrder, calendarSlot };
  const outside = () => {
    throw new Error('запис календаря поза транзакцією видалення наряду');
  };
  const prisma = {
    workOrder,
    calendarSlot: { updateMany: vi.fn(outside), update: vi.fn(outside) },
    $transaction: vi.fn((cb: (t: unknown) => unknown) => cb(tx)),
  };
  const service = new WorkOrdersService(
    prisma as unknown as PrismaService,
    null as never, // stockEffects
    null as never, // docNumbers
    null as never, // pdf
    { record: vi.fn().mockResolvedValue(undefined) } as never, // audit
    null as never, // settingsService
    null as never, // exchangeRates
    { emit: vi.fn() } as never, // events
    null as never, // totals
    null as never, // orgPrintInfo
    null as never, // calendar
  );
  return { service, prisma, workOrder, calendarSlot };
}

describe('WorkOrdersService.remove — записи календаря наряду (BR-WO-017)', () => {
  // guards: BR-WO-017
  it('обидві частини багатоденного запису позначено видаленими разом із нарядом, тим самим часом', async () => {
    const parent = slot('s-parent');
    const continuation = slot('s-cont', { parentSlotId: 's-parent' });
    const h = harness({}, [parent, continuation]);

    await h.service.remove(ORG, WO_ID, 'u');

    const woDeletedAt = h.workOrder.rows[0]!.deletedAt;
    expect(woDeletedAt).toBeInstanceOf(Date);
    expect(parent.deletedAt).toBe(woDeletedAt);
    expect(continuation.deletedAt).toBe(woDeletedAt);
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  // guards: BR-WO-017
  it('чужі записи не чіпає: інший наряд, запис без наряду, інша організація з тим самим id наряду', async () => {
    const own = slot('s-own');
    const otherWo = slot('s-other-wo', { workOrderId: OTHER_WO });
    const noWo = slot('s-no-wo', { workOrderId: null });
    const foreign = slot('s-foreign', { orgId: OTHER_ORG });
    const h = harness({}, [own, otherWo, noWo, foreign]);

    await h.service.remove(ORG, WO_ID, 'u');

    expect(own.deletedAt).toBeInstanceOf(Date);
    expect(otherWo.deletedAt).toBeNull();
    expect(noWo.deletedAt).toBeNull();
    expect(foreign.deletedAt).toBeNull();
    expect(h.calendarSlot.updateMany.mock.calls[0]![0].where).toMatchObject({ orgId: ORG });
  });

  // guards: BR-WO-017
  it('запис, видалений раніше, зберігає свій час видалення', async () => {
    const old = slot('s-old', { deletedAt: EARLIER });
    const h = harness({}, [old, slot('s-live')]);

    await h.service.remove(ORG, WO_ID, 'u');

    expect(old.deletedAt).toBe(EARLIER);
  });

  // guards: BR-WO-017
  it('наряд не видалено (оплата між читанням і записом) → записи календаря живі', async () => {
    const own = slot('s-own');
    const h = harness({}, [own]);
    h.workOrder.findFirst.mockImplementationOnce(() => {
      const snapshot = { ...h.workOrder.rows[0]! };
      h.workOrder.rows[0]!.paidAmount = 80;
      return Promise.resolve(snapshot);
    });

    await expect(h.service.remove(ORG, WO_ID, 'u')).rejects.toThrow('спершу сторнуйте оплату');

    expect(h.workOrder.rows[0]!.deletedAt).toBeNull();
    expect(own.deletedAt).toBeNull();
    expect(h.calendarSlot.updateMany).not.toHaveBeenCalled();
  });

  // guards: BR-WO-017
  it('наряд не в «Чернетці» / «Скасовано» → 400, записи календаря живі', async () => {
    const own = slot('s-own');
    const h = harness({ status: 'IN_PROGRESS' }, [own]);

    await expect(h.service.remove(ORG, WO_ID, 'u')).rejects.toThrow();

    expect(own.deletedAt).toBeNull();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});
