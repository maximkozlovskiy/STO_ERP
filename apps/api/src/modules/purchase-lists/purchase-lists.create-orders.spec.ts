import { describe, it, expect } from 'vitest';
import {
  GOOD,
  GOOD_2,
  ORG,
  SUPPLIER,
  SUPPLIER_2,
  WH,
  WH_2,
  itemRow,
  procurementHarness,
} from './purchase-lists.spec-fixture';

/**
 * Замовлення постачальникам із позицій (BR-PL-008) і спільний шлях створення замовлення
 * (BR-PO-010, `createInTx`) — справжні PurchaseListOrdersService і PurchaseOrdersService над
 * таблицями в пам'яті.
 */

const linesOf = (h: ReturnType<typeof procurementHarness>, poId: string) =>
  h.tables.purchaseOrderLine.rows
    .filter(l => l.purchaseOrderId === poId)
    .map(l => ({ goodId: l.goodId, quantity: l.quantity, price: Number(l.price) }))
    .sort((a, b) => `${String(a.goodId)}${a.price}`.localeCompare(`${String(b.goodId)}${b.price}`));

describe('BR-PL-008 створення замовлень зі списку', () => {
  // guards: BR-PL-008
  it('групи (постачальник, склад) → по DRAFT-замовленню; рядок — (товар, ціна) із сумою кількостей', async () => {
    const h = procurementHarness({
      items: [
        itemRow('i1', { supplierId: SUPPLIER, quantity: 2, expectedPrice: 50 }),
        itemRow('i2', { supplierId: SUPPLIER, quantity: 1, expectedPrice: 50 }),
        itemRow('i3', { supplierId: SUPPLIER, goodId: GOOD_2, quantity: 1 }), // ціна з товару — 80
        itemRow('i4', { supplierId: SUPPLIER, quantity: 4, expectedPrice: 45 }), // інша ціна → інший рядок
        itemRow('i5', { supplierId: SUPPLIER_2, quantity: 1, expectedPrice: 55 }),
        itemRow('i6', { supplierId: SUPPLIER, warehouseId: WH_2, quantity: 1, expectedPrice: 50 }),
      ],
    });

    const { orders } = await h.orders.createOrders(ORG, ['i1', 'i2', 'i3', 'i4', 'i5', 'i6']);

    expect(orders).toHaveLength(3);
    const main = orders.find(o => o.supplierId === SUPPLIER && o.warehouseId === WH)!;
    expect(main.itemsCount).toBe(4);
    expect(linesOf(h, main.id)).toEqual([
      { goodId: GOOD, quantity: 4, price: 45 },
      { goodId: GOOD, quantity: 3, price: 50 },
      { goodId: GOOD_2, quantity: 1, price: 80 },
    ]);
    for (const o of orders) {
      const po = h.tables.purchaseOrder.rows.find(r => r.id === o.id)!;
      expect(po).toMatchObject({
        status: 'DRAFT',
        supplierId: o.supplierId,
        warehouseId: o.warehouseId,
      });
    }
    for (const id of ['i1', 'i2', 'i3', 'i4']) {
      expect(h.item(id)).toMatchObject({ status: 'ORDERED', purchaseOrderId: main.id });
    }
  });

  // guards: BR-PL-008
  it('позиція без постачальника → 400 з назвою товару, нічого не створено', async () => {
    const h = procurementHarness({
      items: [itemRow('i1', { supplierId: SUPPLIER }), itemRow('i2', { goodId: GOOD_2 })],
    });

    await expect(h.orders.createOrders(ORG, ['i1', 'i2'])).rejects.toThrow(/Колодки/);

    expect(h.tables.purchaseOrder.rows).toHaveLength(0);
    expect(h.item('i1')!.status).toBe('OPEN');
  });

  // guards: BR-PL-008
  it('не OPEN або вже в замовленні → 400; чужа/відсутня позиція → 404', async () => {
    const h = procurementHarness({
      items: [
        itemRow('i1', { supplierId: SUPPLIER }),
        itemRow('i2', { supplierId: SUPPLIER, status: 'ORDERED', purchaseOrderId: 'po-x' }),
        itemRow('i3', { supplierId: SUPPLIER, orgId: 'other-org' }),
      ],
    });
    await expect(h.orders.createOrders(ORG, ['i1', 'i2'])).rejects.toThrow(/незамовлені/);
    await expect(h.orders.createOrders(ORG, ['i1', 'i3'])).rejects.toThrow(/i3/);
  });

  // guards: BR-PL-008
  it('номери — до транзакції; позицію змінили паралельно → 409, замовлення відкочено', async () => {
    const h = procurementHarness({
      items: [itemRow('i1', { supplierId: SUPPLIER }), itemRow('i2', { supplierId: SUPPLIER })],
    });
    h.poNumbers.next.mockImplementationOnce(() => {
      h.item('i2')!.status = 'CANCELLED'; // хтось скасував позицію, поки готувалось замовлення
      return Promise.resolve('ЗП-2026-000777');
    });

    await expect(h.orders.createOrders(ORG, ['i1', 'i2'])).rejects.toThrow(
      /змінено іншим користувачем/,
    );

    const tx = (
      h.prisma as unknown as { $transaction: { mock: { invocationCallOrder: number[] } } }
    ).$transaction;
    expect(h.poNumbers.next.mock.invocationCallOrder[0]).toBeLessThan(
      tx.mock.invocationCallOrder[0],
    );
    expect(h.tables.purchaseOrder.rows).toHaveLength(0);
    expect(h.item('i1')).toMatchObject({ status: 'OPEN', purchaseOrderId: null });
  });

  // guards: BR-PO-010
  it('замовлення зі списку створює той самий createInTx, що й POST /purchase-orders', async () => {
    const h = procurementHarness({ items: [itemRow('i1', { supplierId: SUPPLIER, quantity: 2 })] });

    const direct = await h.purchaseOrders.create(ORG, {
      supplierId: SUPPLIER,
      warehouseId: WH,
      lines: [{ goodId: GOOD, quantity: 2, price: 50 }],
    } as never);
    const fromList = (await h.orders.createOrders(ORG, ['i1'])).orders[0];

    const rowOf = (id: string) => h.tables.purchaseOrder.rows.find(r => r.id === id)!;
    const shape = (r: Record<string, unknown>) => ({
      status: r.status,
      supplierId: r.supplierId,
      warehouseId: r.warehouseId,
      currencyId: r.currencyId,
      totalAmount: r.totalAmount,
    });
    expect(shape(rowOf(fromList.id))).toEqual(shape(rowOf(direct.id)));
  });
});

describe('BR-PL-018 замовлення зі списку з пропозиціями', () => {
  // guards: BR-PL-018
  it('рядок — на (товар, ціна, пропозиція): склади постачальника не зливаються, та сама пропозиція — зливається', async () => {
    const h = procurementHarness({
      items: [
        itemRow('i1', {
          supplierId: SUPPLIER,
          quantity: 2,
          expectedPrice: 120,
          offerKey: '45000|6',
          offerConnectionId: 'c1',
        }),
        itemRow('i2', {
          supplierId: SUPPLIER,
          quantity: 3,
          expectedPrice: 120,
          offerKey: '45000|15',
          offerConnectionId: 'c1',
        }),
        itemRow('i3', {
          supplierId: SUPPLIER,
          quantity: 1,
          expectedPrice: 120,
          offerKey: '45000|6',
          offerConnectionId: 'c1',
        }),
      ],
    });
    const { orders } = await h.orders.createOrders(ORG, ['i1', 'i2', 'i3']);
    expect(orders).toHaveLength(1);
    expect(linesOf(h, orders[0].id)).toEqual([
      { goodId: GOOD, quantity: 3, price: 120 },
      { goodId: GOOD, quantity: 3, price: 120 },
    ]);
  });

  // guards: BR-PL-018
  it('замовлення в гривні: ціна рядка — expectedPrice позиції (уже в гривні), валюта — базова', async () => {
    const h = procurementHarness({
      items: [
        itemRow('i1', {
          supplierId: SUPPLIER,
          quantity: 2,
          expectedPrice: 118.3,
          offerKey: 'k',
          offerPrice: 2.6,
          offerCurrencyCode: 'EUR',
        }),
      ],
    });
    const { orders } = await h.orders.createOrders(ORG, ['i1']);
    expect(linesOf(h, orders[0].id)).toEqual([{ goodId: GOOD, quantity: 2, price: 118.3 }]);
    expect(h.tables.purchaseOrder.rows[0]).toMatchObject({ currencyId: 'cur-uah' });
  });
});
