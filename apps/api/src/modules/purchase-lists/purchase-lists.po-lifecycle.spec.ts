import { describe, it, expect } from 'vitest';
import {
  GOOD,
  GOOD_2,
  ORG,
  SUPPLIER,
  WH,
  WH_2,
  WO_A,
  WO_B,
  itemRow,
  partRow,
  procurementHarness,
  woRow,
} from './purchase-lists.spec-fixture';

/**
 * Замовлення постачальнику і позиції списків купівлі (BR-PL-009, 010, 012, BR-PO-010) —
 * справжні PurchaseOrdersService і PurchaseListLinkService над таблицями в пам'яті.
 */

const PO = 'po-1';

function poRow(status: string) {
  return {
    id: PO,
    orgId: ORG,
    number: 'ЗП-1',
    status,
    supplierId: SUPPLIER,
    warehouseId: WH,
    contractId: null,
    totalAmount: 100,
    paidAmount: 0,
    paymentDate: null,
    currencyId: 'cur-uah',
    documentDate: new Date('2026-10-17'),
    trackingNumber: null,
    notes: null,
    createdAt: new Date('2026-10-17T07:00:00Z'),
    updatedAt: new Date('2026-10-17T07:00:00Z'),
    deletedAt: null,
  };
}

const line = (id: string, goodId: string, quantity: number, receivedQty = 0) => ({
  id,
  orgId: ORG,
  purchaseOrderId: PO,
  goodId,
  quantity,
  receivedQty,
  price: 50,
  unitOfMeasureId: null,
  deletedAt: null,
});

const ordered = (over: Record<string, unknown>) => ({
  status: 'ORDERED',
  purchaseOrderId: PO,
  supplierId: SUPPLIER,
  source: 'WORK_ORDER',
  workOrderId: WO_A,
  workOrderPartId: 'pa',
  ...over,
});

const harness = (
  status: string,
  lines: ReturnType<typeof line>[],
  items: Record<string, unknown>[],
) =>
  procurementHarness({
    workOrders: [woRow(WO_A, { status: 'APPROVED' }), woRow(WO_B, { status: 'CANCELLED' })],
    parts: [partRow('pa', WO_A, { quantity: 5 })],
    purchaseOrders: [poRow(status)],
    purchaseOrderLines: lines,
    items,
  });

describe('BR-PL-009 звірка чернетки, коли рядки переписано', () => {
  // guards: BR-PL-009, BR-PO-010
  it('товару немає → OPEN; позицій більше, ніж замовлено, → новіша розділяється', async () => {
    const h = harness(
      'DRAFT',
      [line('l1', GOOD, 4), line('l2', GOOD_2, 1)],
      [
        itemRow('i1', ordered({ quantity: 2 })),
        itemRow('i2', ordered({ quantity: 2 })),
        itemRow('i3', ordered({ quantity: 1, goodId: GOOD_2 })),
      ],
    );

    await h.purchaseOrders.update(ORG, PO, {
      lines: [{ goodId: GOOD, quantity: 3, price: 50 }],
    } as never);

    expect(h.item('i1')).toMatchObject({ status: 'ORDERED', quantity: 2, purchaseOrderId: PO });
    expect(h.item('i2')).toMatchObject({ status: 'ORDERED', quantity: 1, purchaseOrderId: PO });
    expect(h.item('i3')).toMatchObject({ status: 'OPEN', purchaseOrderId: null });
    const rest = h.liveItems().filter(i => !['i1', 'i2', 'i3'].includes(i.id as string));
    expect(rest).toEqual([
      expect.objectContaining({
        status: 'OPEN',
        quantity: 1,
        purchaseOrderId: null,
        workOrderPartId: 'pa',
      }),
    ]);
  });
});

describe('BR-PL-009 звірка чернетки, коли змінено склад', () => {
  // guards: BR-PL-009
  it('склад чернетки змінено → позиції іншого складу повертаються в OPEN без замовлення', async () => {
    const h = harness('DRAFT', [line('l1', GOOD, 2)], [itemRow('i1', ordered({ quantity: 2 }))]);

    await h.purchaseOrders.update(ORG, PO, { warehouseId: WH_2 } as never);

    // Приймання розподіляє лише між позиціями складу замовлення (BR-PL-011) — позиція WH
    // інакше лишилась би ORDERED назавжди, а резерв під наряд не з'явився б.
    expect(h.item('i1')).toMatchObject({ status: 'OPEN', purchaseOrderId: null });
  });
});

describe('BR-PL-010 видалення й скасування замовлення', () => {
  // guards: BR-PL-010
  it('видалена чернетка: позиції → OPEN без замовлення', async () => {
    const h = harness('DRAFT', [line('l1', GOOD, 2)], [itemRow('i1', ordered({ quantity: 2 }))]);

    await h.purchaseOrders.remove(ORG, PO);

    expect(h.item('i1')).toMatchObject({ status: 'OPEN', purchaseOrderId: null });
    expect(h.tables.purchaseOrder.rows[0].deletedAt).not.toBeNull();
  });

  // guards: BR-PL-010
  it('скасоване після часткового приймання: отримане → RECEIVED, решта — нова позиція', async () => {
    const h = harness(
      'PARTIAL',
      [line('l1', GOOD, 3, 1)],
      [
        itemRow('i1', ordered({ quantity: 2, receivedQty: 1, reservedQty: 1 })),
        itemRow('i2', ordered({ quantity: 1 })),
        // Наряд уже скасовано: його решта не відкривається знову.
        itemRow(
          'i3',
          ordered({ quantity: 2, receivedQty: 1, workOrderId: WO_B, workOrderPartId: 'pb' }),
        ),
      ],
    );

    await h.purchaseOrders.transition(ORG, PO, 'CANCELLED' as never);

    expect(h.item('i1')).toMatchObject({ status: 'RECEIVED', quantity: 1, purchaseOrderId: PO });
    expect(h.item('i2')).toMatchObject({ status: 'OPEN', purchaseOrderId: null });
    expect(h.item('i3')).toMatchObject({ status: 'RECEIVED', quantity: 1 });
    const rest = h.liveItems().filter(i => !['i1', 'i2', 'i3'].includes(i.id as string));
    expect(rest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workOrderId: WO_A,
          status: 'OPEN',
          quantity: 1,
          purchaseOrderId: null,
        }),
        expect.objectContaining({ workOrderId: WO_B, status: 'CANCELLED', quantity: 1 }),
      ]),
    );
  });

  // guards: BR-PL-010
  it('видалити можна лише чернетку — замовлене не чіпається', async () => {
    const h = harness('ORDERED', [line('l1', GOOD, 2)], [itemRow('i1', ordered({ quantity: 2 }))]);
    await expect(h.purchaseOrders.remove(ORG, PO)).rejects.toThrow();
    expect(h.item('i1')).toMatchObject({ status: 'ORDERED', purchaseOrderId: PO });
  });
});

describe('BR-PL-012 остача після повного приймання', () => {
  // guards: BR-PL-012
  it('замовлення RECEIVED, а позиція отримала менше → отримане RECEIVED, на решту нова OPEN', async () => {
    const h = harness(
      'ORDERED',
      [line('l1', GOOD, 3)],
      [itemRow('i1', ordered({ quantity: 2 })), itemRow('i2', ordered({ quantity: 2 }))],
    );

    await h.purchaseOrders.receive(ORG, PO, { lines: [{ lineId: 'l1', receivedQty: 3 }] } as never);

    expect(h.tables.purchaseOrder.rows[0].status).toBe('RECEIVED');
    expect(h.item('i1')).toMatchObject({ status: 'RECEIVED', receivedQty: 2 });
    expect(h.item('i2')).toMatchObject({ status: 'RECEIVED', quantity: 1, receivedQty: 1 });
    const rest = h.liveItems().filter(i => !['i1', 'i2'].includes(i.id as string));
    expect(rest).toEqual([
      expect.objectContaining({
        status: 'OPEN',
        quantity: 1,
        purchaseOrderId: null,
        workOrderId: WO_A,
        workOrderPartId: 'pa',
        supplierId: SUPPLIER,
      }),
    ]);
  });

  // guards: BR-PL-012
  it('замовлення закрите переходом «Отримано» з недостачею → остача в OPEN, як при прийманні (Bug #885)', async () => {
    const h = harness(
      'PARTIAL',
      [line('l1', GOOD, 5, 1)],
      [
        itemRow('i1', ordered({ quantity: 2, receivedQty: 1, reservedQty: 1 })),
        itemRow('i2', ordered({ quantity: 3 })),
      ],
    );

    await h.purchaseOrders.transition(ORG, PO, 'RECEIVED' as never);

    // Без цього позиції лишались ORDERED на закритому замовленні, а їхнє недоотримане нестача
    // рахувала покриттям — наряди переставали показувати, що товару бракує.
    expect(h.tables.purchaseOrder.rows[0].status).toBe('RECEIVED');
    expect(h.item('i1')).toMatchObject({ status: 'RECEIVED', quantity: 1, receivedQty: 1 });
    expect(h.item('i2')).toMatchObject({ status: 'OPEN', purchaseOrderId: null });
    const rest = h.liveItems().filter(i => !['i1', 'i2'].includes(i.id as string));
    expect(rest).toEqual([
      expect.objectContaining({ status: 'OPEN', quantity: 1, purchaseOrderId: null }),
    ]);
    expect(h.liveItems().filter(i => i.status === 'ORDERED')).toEqual([]);
  });

  // guards: BR-PL-012
  it('часткове приймання (PARTIAL) позицій не розділяє', async () => {
    const h = harness('ORDERED', [line('l1', GOOD, 4)], [itemRow('i1', ordered({ quantity: 4 }))]);

    await h.purchaseOrders.receive(ORG, PO, { lines: [{ lineId: 'l1', receivedQty: 1 }] } as never);

    expect(h.tables.purchaseOrder.rows[0].status).toBe('PARTIAL');
    expect(h.item('i1')).toMatchObject({ status: 'ORDERED', quantity: 4, receivedQty: 1 });
    expect(h.liveItems()).toHaveLength(1);
  });
});
