/**
 * BR-WO-031 — «Виставлено» → «Скасовано», коли сплачено 0 (рішення власника 2026-10-22).
 *
 * Після сторно оплати (BR-PAY-024) повністю оплачений наряд повертається в «Виставлено», а звідти
 * карта переходів вела лише в «Оплачено» — наряд не можна було ні скасувати, ні видалити. Тепер
 * «Виставлено» скасовується так само, як «Виконано»: у обох списано запчастини й нараховано один
 * CHARGE, тож — повернення складу й одне сторно боргу (`returnPartsAndCredit`), без зняття резерву.
 * Рахунок наряду (чернетка, виставлений, частково оплачений, прострочений) скасовується в тій самій
 * транзакції — і для «Виконано» теж (раніше лишався живим).
 *
 * Справжній WorkOrdersService над таблицями в пам'яті (`planningHarness`): `where` у CAS наряду й
 * у `invoice.updateMany` виконується по-справжньому, `$transaction` відкочує таблиці при винятку.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  NOW,
  ORG,
  OTHER_ORG,
  OTHER_WO,
  WO_ID,
  planningHarness,
  woRow,
} from './work-orders.planning.spec-fixture';

const inv = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id,
  orgId: ORG,
  workOrderId: WO_ID,
  status,
  deletedAt: null,
  ...over,
});

function harness(status: string, paidAmount = 0, invoices = [inv('inv-1', 'SENT')]) {
  const h = planningHarness({
    workOrders: [woRow({ status, paidAmount }), woRow({ id: OTHER_WO, number: 'НРД-9' })],
    invoices,
  });
  // Як Prisma: прочитаний рядок — копія, а не живий рядок таблиці.
  const read = h.workOrder.findFirst.getMockImplementation()!;
  h.workOrder.findFirst.mockImplementation(async (args?: unknown) => {
    const row = await read(args as never);
    return row && { ...row };
  });
  return h;
}

const statusOf = (h: ReturnType<typeof harness>, id: string) =>
  h.invoice.rows.find(r => r.id === id)!.status;

describe('WorkOrdersService.transition: «Виставлено» → «Скасовано» (BR-WO-031)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-WO-031
  it('сплачено 0 → скасовано: склад і борг повертаються один раз, резерв не знімається', async () => {
    const h = harness('INVOICED');

    await h.service.transition(ORG, WO_ID, 'CANCELLED' as never, 'u');

    expect(h.workOrder.rows.find(w => w.id === WO_ID)!.status).toBe('CANCELLED');
    expect(h.stockEffects.returnPartsAndCredit).toHaveBeenCalledTimes(1);
    expect(h.stockEffects.releaseAllNetReservations).not.toHaveBeenCalled();
  });

  // guards: BR-WO-031
  it.each(['DRAFT', 'SENT', 'PARTIALLY_PAID', 'OVERDUE'])(
    'рахунок наряду в стані %s скасовується разом із нарядом',
    async invStatus => {
      const h = harness('INVOICED', 0, [inv('inv-1', invStatus)]);

      await h.service.transition(ORG, WO_ID, 'CANCELLED' as never, 'u');

      expect(statusOf(h, 'inv-1')).toBe('CANCELLED');
    },
  );

  // guards: BR-WO-031
  it('«Виконано» → «Скасовано» теж скасовує рахунок наряду; чужі й видалені рахунки не чіпає', async () => {
    const h = harness('COMPLETED', 0, [
      inv('inv-1', 'DRAFT'),
      inv('inv-other-wo', 'SENT', { workOrderId: OTHER_WO }),
      inv('inv-foreign', 'SENT', { orgId: OTHER_ORG }),
      inv('inv-deleted', 'DRAFT', { deletedAt: new Date('2026-05-01T00:00:00Z') }),
      inv('inv-paid', 'PAID'),
    ]);

    await h.service.transition(ORG, WO_ID, 'CANCELLED' as never, 'u');

    expect(statusOf(h, 'inv-1')).toBe('CANCELLED');
    expect(statusOf(h, 'inv-other-wo')).toBe('SENT');
    expect(statusOf(h, 'inv-foreign')).toBe('SENT');
    expect(statusOf(h, 'inv-deleted')).toBe('DRAFT');
    expect(statusOf(h, 'inv-paid')).toBe('PAID');
    expect(h.stockEffects.returnPartsAndCredit).toHaveBeenCalledTimes(1);
  });

  // guards: BR-WO-031, BR-WO-014
  it('сплачено більше 0 → 400, наряд і рахунок не змінено, борг не сторновано', async () => {
    const h = harness('INVOICED', 50);

    await expect(h.service.transition(ORG, WO_ID, 'CANCELLED' as never, 'u')).rejects.toThrow();

    expect(h.workOrder.rows.find(w => w.id === WO_ID)!.status).toBe('INVOICED');
    expect(statusOf(h, 'inv-1')).toBe('SENT');
    expect(h.stockEffects.returnPartsAndCredit).not.toHaveBeenCalled();
  });

  // guards: BR-WO-031, BR-WO-014
  it('оплата між читанням і записом (CAS програв) → відмова, рахунок живий, сторно боргу немає', async () => {
    const h = harness('INVOICED');
    h.workOrder.findFirst.mockImplementationOnce(() => {
      const snapshot = { ...h.workOrder.rows.find(w => w.id === WO_ID)! };
      h.workOrder.rows.find(w => w.id === WO_ID)!.paidAmount = 80;
      return Promise.resolve(snapshot);
    });

    await expect(h.service.transition(ORG, WO_ID, 'CANCELLED' as never, 'u')).rejects.toThrow();

    expect(h.workOrder.rows.find(w => w.id === WO_ID)!.status).toBe('INVOICED');
    expect(statusOf(h, 'inv-1')).toBe('SENT');
    expect(h.stockEffects.returnPartsAndCredit).not.toHaveBeenCalled();
  });
});
