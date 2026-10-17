import { describe, it, expect, vi } from 'vitest';
import {
  GOOD,
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
 * Приймання від постачальника резервує отримане під наряди (BR-PL-011, BR-PO-009, BR-INVT-018) і
 * «Зняти резерв» (BR-PL-016) — справжні PurchaseOrdersService.receive, PurchaseListReceiptService,
 * InventoryService над таблицями в пам'яті.
 */

const PO = 'po-1';

function harness(
  over: { woA?: Record<string, unknown>; partA?: number; items?: Record<string, unknown>[] } = {},
) {
  return procurementHarness({
    workOrders: [
      woRow(WO_A, { status: 'APPROVED', ...over.woA }),
      woRow(WO_B, { status: 'DRAFT' }),
    ],
    parts: [
      partRow('pa', WO_A, { quantity: over.partA ?? 2 }),
      partRow('pb', WO_B, { quantity: 1 }),
    ],
    purchaseOrders: [
      {
        id: PO,
        orgId: ORG,
        number: 'ЗП-1',
        status: 'ORDERED',
        supplierId: SUPPLIER,
        warehouseId: WH,
        totalAmount: 150,
        paidAmount: 0,
        paymentDate: null,
        currencyId: null,
        notes: null,
        createdAt: new Date('2026-10-17T07:00:00Z'),
        updatedAt: new Date('2026-10-17T07:00:00Z'),
        deletedAt: null,
      },
    ],
    purchaseOrderLines: [
      {
        id: 'l1',
        orgId: ORG,
        purchaseOrderId: PO,
        goodId: GOOD,
        quantity: 3,
        receivedQty: 0,
        price: 50,
        unitOfMeasureId: null,
        deletedAt: null,
      },
    ],
    items: over.items ?? [
      itemRow('ia', ordered(WO_A, 'pa', 2)),
      itemRow('ib', ordered(WO_B, 'pb', 1)),
    ],
  });
}

function ordered(workOrderId: string, workOrderPartId: string, quantity: number) {
  return {
    workOrderId,
    workOrderPartId,
    quantity,
    status: 'ORDERED',
    purchaseOrderId: PO,
    supplierId: SUPPLIER,
    source: 'WORK_ORDER',
  };
}

const receive = (h: ReturnType<typeof harness>, qty: number) =>
  h.purchaseOrders.receive(ORG, PO, { lines: [{ lineId: 'l1', receivedQty: qty }] } as never, 'u');

describe('BR-PL-011 розподіл отриманого між позиціями й резерв під наряди', () => {
  // guards: BR-PL-011, BR-INVT-018
  it('FIFO за позиціями; кожному наряду — резерв рухом RESERVATION з documentType WorkOrder', async () => {
    const h = harness();

    await receive(h, 3);

    expect(h.item('ia')).toMatchObject({ status: 'RECEIVED', receivedQty: 2, reservedQty: 2 });
    expect(h.item('ib')).toMatchObject({ status: 'RECEIVED', receivedQty: 1, reservedQty: 1 });
    expect(h.netOf(WO_A)).toBe(2);
    expect(h.netOf(WO_B)).toBe(1);
    expect(h.reserved()).toBe(3);
    const reservations = h.tables.stockMovement.rows.filter(m => m.type === 'RESERVATION');
    expect(reservations.every(m => m.documentType === 'WorkOrder')).toBe(true);
  });

  // guards: BR-PL-011
  it('часткове приймання: спершу старша позиція; решта — наступним прийманням', async () => {
    const h = harness();

    await receive(h, 1);
    expect(h.item('ia')).toMatchObject({ status: 'ORDERED', receivedQty: 1, reservedQty: 1 });
    expect(h.item('ib')).toMatchObject({ status: 'ORDERED', receivedQty: 0 });

    await receive(h, 2);
    expect(h.item('ia')).toMatchObject({ status: 'RECEIVED', receivedQty: 2, reservedQty: 2 });
    expect(h.item('ib')).toMatchObject({ status: 'RECEIVED', receivedQty: 1, reservedQty: 1 });
  });

  // guards: BR-PL-011
  it('резерв обмежує непокрита потреба: наряду треба 1 (позиція на 2) → резерв 1, 1 — вільний', async () => {
    const h = harness({ partA: 1 });

    await receive(h, 3);

    expect(h.item('ia')).toMatchObject({ status: 'RECEIVED', receivedQty: 2, reservedQty: 1 });
    expect(h.netOf(WO_A)).toBe(1);
    expect(h.reserved()).toBe(2); // 1 для WO_A + 1 для WO_B; 1 — вільний залишок
  });

  // guards: BR-PL-011
  it.each([
    ['COMPLETED', {}],
    ['CANCELLED', {}],
    ['DRAFT (видалений)', { status: 'DRAFT', deletedAt: new Date() }],
  ])('наряд %s: позиція отримує товар, але резерву під наряд немає', async (_l, woA) => {
    const h = harness({ woA: { status: 'COMPLETED', ...woA } });
    if (_l === 'CANCELLED') h.tables.workOrder.rows[0].status = 'CANCELLED';

    await receive(h, 3);

    expect(h.item('ia')).toMatchObject({ status: 'RECEIVED', receivedQty: 2, reservedQty: 0 });
    expect(h.netOf(WO_A)).toBe(0);
    expect(h.netOf(WO_B)).toBe(1);
  });

  // guards: BR-PL-011
  it('позиція іншого складу не отримує товару складу замовлення', async () => {
    const h = harness({
      items: [
        itemRow('ia', { ...ordered(WO_A, 'pa', 2), warehouseId: WH_2 }),
        itemRow('ib', ordered(WO_B, 'pb', 1)),
      ],
    });

    await receive(h, 3);

    expect(h.item('ib')).toMatchObject({ status: 'RECEIVED', receivedQty: 1 });
    // Нічого не отримала; замовлення закрите повністю → позиція повертається до замовлення (BR-PL-012).
    expect(h.item('ia')).toMatchObject({ status: 'OPEN', receivedQty: 0, purchaseOrderId: null });
  });

  // guards: BR-PL-011
  it('наряди блокуються ДО руху складу (порядок «наряд → склад»)', async () => {
    const h = harness();

    await receive(h, 3);

    const firstStock = h.events.findIndex(e => e.startsWith('RECEIPT:'));
    expect(h.events.slice(0, firstStock)).toEqual([`lock:${WO_A}`, `lock:${WO_B}`]);
  });

  // guards: BR-PL-011
  it('«В роботу» після приймання не подвоює резерв', async () => {
    const h = harness();
    await receive(h, 3);

    await h.workOrders.transition(ORG, WO_A, 'IN_PROGRESS' as never);

    expect(h.netOf(WO_A)).toBe(2);
    expect(h.reserved()).toBe(3);
  });
});

describe('BR-PO-009 рух приймання і борг', () => {
  // guards: BR-PO-009
  it('RECEIPT несе purchaseOrderLineId; резерв — до боргу постачальнику', async () => {
    const h = harness();
    const spy = vi.spyOn(h.inventory, 'createMovement');

    await receive(h, 3);

    const receipt = spy.mock.calls.find(c => c[1].type === 'RECEIPT')!;
    expect(receipt[1]).toMatchObject({ purchaseOrderLineId: 'l1', documentType: 'PurchaseOrder' });
    const lastReservation = Math.max(
      ...spy.mock.calls.map((c, i) =>
        c[1].type === 'RESERVATION' ? spy.mock.invocationCallOrder[i] : 0,
      ),
    );
    expect(lastReservation).toBeGreaterThan(0);
    expect(lastReservation).toBeLessThan(
      h.supplierSettlements.createTransaction.mock.invocationCallOrder[0],
    );
  });
});

describe('BR-PL-016 «Зняти резерв»', () => {
  // guards: BR-PL-016
  it('знімає зарезервоване позицією (RESERVATION_RELEASE), повторно → 400', async () => {
    const h = harness();
    await receive(h, 3);

    const res = await h.items.releaseReservation(ORG, 'ia', 'u');

    expect(res.released).toBe(2);
    expect(res.item.reservedQty).toBe(0);
    expect(h.netOf(WO_A)).toBe(0);
    expect(h.reserved()).toBe(1);
    await expect(h.items.releaseReservation(ORG, 'ia', 'u')).rejects.toThrow(
      /нічого не зарезервовано/,
    );
  });

  // guards: BR-PL-016
  it('не більше net-резерву наряду: резерв уже знято скасуванням наряду → 400', async () => {
    const h = harness();
    await receive(h, 3);
    await h.workOrders.transition(ORG, WO_A, 'CANCELLED' as never);

    await expect(h.items.releaseReservation(ORG, 'ia', 'u')).rejects.toThrow(
      /нічого не зарезервовано/,
    );
    expect(h.reserved()).toBe(1); // резерв WO_B не зачеплено
  });

  // guards: BR-PL-016, BR-WO-021
  it('скасування наряду обнуляє reservedQty його позицій — «зарезервовано» не бреше', async () => {
    const h = harness();
    await receive(h, 3);
    expect(h.item('ia')!.reservedQty).toBe(2);

    await h.workOrders.transition(ORG, WO_A, 'CANCELLED' as never);

    expect(h.item('ia')).toMatchObject({ status: 'RECEIVED', receivedQty: 2, reservedQty: 0 });
    expect(h.item('ib')!.reservedQty).toBe(1); // позиція іншого наряду не зачеплена
  });
});
