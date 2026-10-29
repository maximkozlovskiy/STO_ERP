/**
 * BR-AUT-060 — події outbox наряду і рахунку при переході наряду.
 *
 * Справжній WorkOrdersService над таблицями в пам'яті (`planningHarness`): `domainEvent` — така
 * сама таблиця, як наряди й рахунки, і `$transaction` відкочує її разом з ними. Тож «подія в тій
 * самій транзакції» перевіряється результатом: перехід упав після запису статусу — події немає.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  NOW,
  ORG,
  OTHER_WO,
  WO_ID,
  planningHarness,
  woRow,
} from './work-orders.planning.spec-fixture';
import type { MemRow } from '../cash/cash.spec-fixture';

const USER = 'emp-1';

const inv = (id: string, status: string) => ({
  id,
  orgId: ORG,
  workOrderId: WO_ID,
  status,
  deletedAt: null,
});

function harness(status: string, invoices: MemRow[] = []) {
  const h = planningHarness({
    workOrders: [woRow({ status }), woRow({ id: OTHER_WO, number: 'НРД-9' })],
    invoices,
  });
  // Як Prisma: прочитаний рядок — копія, а не живий рядок таблиці.
  for (const table of [h.workOrder, h.invoice]) {
    const read = table.findFirst.getMockImplementation()!;
    table.findFirst.mockImplementation(async (args?: unknown) => {
      const row = await read(args as never);
      return row && { ...row };
    });
    const many = table.findMany.getMockImplementation()!;
    table.findMany.mockImplementation(async (args?: unknown) =>
      ((await many(args as never)) as MemRow[]).map(r => ({ ...r })),
    );
  }
  const events = () =>
    h.prisma.domainEvent.rows.map(e => ({
      documentType: e.documentType,
      documentId: e.documentId,
      kind: e.kind,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      actorId: e.actorId,
    }));
  return { ...h, events };
}

describe('WorkOrdersService.transition — подія outbox (BR-AUT-060)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-AUT-060
  it('перехід → одна подія наряду: з якого, в який статус, ініціатор', async () => {
    const h = harness('APPROVED');

    await h.service.transition(ORG, WO_ID, 'ON_HOLD' as never, USER);

    expect(h.events()).toEqual([
      {
        documentType: 'WORK_ORDER',
        documentId: WO_ID,
        kind: 'STATUS_CHANGED',
        fromStatus: 'APPROVED',
        toStatus: 'ON_HOLD',
        actorId: USER,
      },
    ]);
    expect(h.prisma.domainEvent.rows[0].orgId).toBe(ORG);
  });

  // guards: BR-AUT-060
  it('скасування наряду: подія наряду + подія КОЖНОГО живого рахунку з його попереднім статусом', async () => {
    const h = harness('COMPLETED', [
      inv('inv-sent', 'SENT'),
      inv('inv-draft', 'DRAFT'),
      inv('inv-old', 'CANCELLED'),
    ]);

    await h.service.transition(ORG, WO_ID, 'CANCELLED' as never, USER);

    expect(h.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentType: 'WORK_ORDER',
          fromStatus: 'COMPLETED',
          toStatus: 'CANCELLED',
        }),
        expect.objectContaining({
          documentType: 'INVOICE',
          documentId: 'inv-sent',
          fromStatus: 'SENT',
          toStatus: 'CANCELLED',
          actorId: USER,
        }),
        expect.objectContaining({
          documentType: 'INVOICE',
          documentId: 'inv-draft',
          fromStatus: 'DRAFT',
          toStatus: 'CANCELLED',
        }),
      ]),
    );
    // Уже скасований рахунок не змінювався — і події не має.
    expect(h.events()).toHaveLength(3);
  });

  // guards: BR-WO-031, BR-AUT-060
  it('рахунок між читанням і записом став «Прострочено» → усе одно скасовується, подія з OVERDUE', async () => {
    const h = harness('COMPLETED', [inv('inv-sent', 'SENT')]);
    // Нічний OVERDUE встиг між вибіркою живих рахунків і CAS скасування.
    const many = h.invoice.findMany.getMockImplementation()!;
    h.invoice.findMany.mockImplementation(async (args?: unknown) => {
      const rows = await many(args as never);
      const where = (args as { where?: { status?: { in?: unknown } } } | undefined)?.where;
      if (where?.status?.in) h.invoice.rows.find(r => r.id === 'inv-sent')!.status = 'OVERDUE';
      return rows;
    });

    await h.service.transition(ORG, WO_ID, 'CANCELLED' as never, USER);

    expect(h.invoice.rows.find(r => r.id === 'inv-sent')!.status).toBe('CANCELLED');
    expect(h.events()).toContainEqual(
      expect.objectContaining({
        documentType: 'INVOICE',
        documentId: 'inv-sent',
        fromStatus: 'OVERDUE',
        toStatus: 'CANCELLED',
      }),
    );
  });

  // guards: BR-AUT-060
  it('перехід упав після запису статусу → відкат: ні нового статусу, ні події', async () => {
    const h = harness('COMPLETED', [inv('inv-sent', 'SENT')]);
    h.stockEffects.returnPartsAndCredit.mockRejectedValueOnce(new Error('склад недоступний'));

    await expect(h.service.transition(ORG, WO_ID, 'CANCELLED' as never, USER)).rejects.toThrow(
      'склад недоступний',
    );

    expect(h.workOrder.rows.find(w => w.id === WO_ID)!.status).toBe('COMPLETED');
    expect(h.invoice.rows.find(r => r.id === 'inv-sent')!.status).toBe('SENT');
    expect(h.prisma.domainEvent.rows).toHaveLength(0);
  });

  // guards: BR-AUT-060
  it('створення наряду → подія «створено» з ініціатором', async () => {
    const h = harness('DRAFT');
    h.workOrder.rows.splice(0);

    const wo = await h.service.create(
      ORG,
      {
        branchId: woRow().branchId,
        vehicleId: woRow().vehicleId,
        counterpartyId: woRow().counterpartyId,
      } as never,
      USER,
    );

    expect(h.events()).toEqual([
      {
        documentType: 'WORK_ORDER',
        documentId: wo.id,
        kind: 'CREATED',
        fromStatus: null,
        toStatus: 'DRAFT',
        actorId: USER,
      },
    ]);
  });
});
