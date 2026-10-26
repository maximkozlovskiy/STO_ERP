import { describe, expect, it } from 'vitest';
import type { MemRow } from '../cash/cash.spec-fixture';
import {
  ORG,
  SUPPLIER,
  SUPPLIER_2,
  WO_A,
  itemRow,
  partRow,
  procurementHarness,
  woRow,
} from './purchase-lists.spec-fixture';

/**
 * Знімок обраної пропозиції постачальника на позиції (BR-PL-017, 019; BR-SCON-013) —
 * справжні сервіси списків над таблицями в пам'яті.
 */
const CONN = '71111111-1111-4111-8111-111111111111';
const SNAPSHOT: MemRow = {
  supplierId: SUPPLIER,
  expectedPrice: 134.28,
  offerConnectionId: CONN,
  offerKey: '45000|15',
  offerSupplierItemId: '45000',
  offerArticle: 'OC 90',
  offerBrand: 'MAHLE',
  offerWarehouseCode: '15',
  offerWarehouseName: 'Київ',
  offerDeliveryDays: 2,
  offerPrice: 134.28,
  offerCurrencyCode: 'UAH',
  offerMultiplicity: 1,
  offerIsAnalog: false,
  offeredAt: new Date('2026-10-18T08:00:00Z'),
  offerChosenBy: 'MANUAL',
};
const snapshotOf = (r: MemRow | undefined) => ({
  offerConnectionId: r?.offerConnectionId ?? null,
  offerKey: r?.offerKey ?? null,
  offerPrice: r?.offerPrice ?? null,
  offerChosenBy: r?.offerChosenBy ?? null,
});

describe('BR-PL-017 знімок пропозиції йде за позицією', () => {
  // guards: BR-PL-017
  it('«Розділити» — обидві частини з тією самою пропозицією', async () => {
    const h = procurementHarness({ items: [itemRow('i1', { quantity: 5, ...SNAPSHOT })] });
    const [, part] = await h.items.split(ORG, 'i1', { quantity: 2 });
    expect(part).toMatchObject({
      quantity: 2,
      offerKey: '45000|15',
      offerConnectionId: CONN,
      offerChosenBy: 'MANUAL',
    });
    expect(snapshotOf(h.item('i1'))).toEqual(snapshotOf(h.liveItems().find(r => r.id !== 'i1')));
  });

  // guards: BR-PL-017
  it('остача при скасуванні частково отриманого замовлення — нова OPEN-частина з пропозицією', async () => {
    const h = procurementHarness({
      items: [
        itemRow('i1', {
          quantity: 4,
          receivedQty: 1,
          status: 'ORDERED',
          purchaseOrderId: 'po-1',
          ...SNAPSHOT,
        }),
      ],
    });
    await h.links.onOrderClosed(h.prisma as never, ORG, 'po-1');
    const rest = h.liveItems().find(r => r.id !== 'i1')!;
    expect(h.item('i1')).toMatchObject({ status: 'RECEIVED', quantity: 1 });
    expect(rest).toMatchObject({ status: 'OPEN', quantity: 3 });
    expect(rest.purchaseOrderId ?? null).toBeNull();
    expect(snapshotOf(rest)).toEqual(snapshotOf(h.item('i1')));
  });

  // guards: BR-SCON-013
  it('повернення непідтвердженого — БЕЗ пропозиції: частина відділяється, ціла позиція стає OPEN', async () => {
    const h = procurementHarness({
      items: [
        itemRow('i1', { quantity: 4, status: 'ORDERED', purchaseOrderId: 'po-1', ...SNAPSHOT }),
        itemRow('i2', { quantity: 2, status: 'ORDERED', purchaseOrderId: 'po-1', ...SNAPSHOT }),
      ],
    });
    await h.links.releaseFromOrder(h.prisma as never, ORG, h.item('i1') as never, 3);
    await h.links.releaseFromOrder(h.prisma as never, ORG, h.item('i2') as never, 5);
    expect(h.item('i1')).toMatchObject({ status: 'ORDERED', quantity: 1, offerKey: '45000|15' });
    const released = h.liveItems().find(r => r.id !== 'i1' && r.id !== 'i2')!;
    expect(released).toMatchObject({ status: 'OPEN', quantity: 3, supplierId: SUPPLIER });
    expect(snapshotOf(released)).toEqual({
      offerConnectionId: null,
      offerKey: null,
      offerPrice: null,
      offerChosenBy: null,
    });
    expect(h.item('i2')).toMatchObject({
      status: 'OPEN',
      purchaseOrderId: null,
      quantity: 2,
      offerKey: null,
      offerChosenBy: null,
    });
  });
});

describe('BR-PL-019 ручна зміна позиції й пропозиція', () => {
  // guards: BR-PL-019
  it('інший постачальник скидає знімок; той самий — лишає', async () => {
    const h = procurementHarness({
      items: [
        itemRow('i1', { quantity: 3, ...SNAPSHOT }),
        itemRow('i2', { quantity: 3, ...SNAPSHOT }),
      ],
    });
    const changed = await h.items.update(ORG, 'i1', { supplierId: SUPPLIER_2 });
    expect(changed).toMatchObject({
      supplierId: SUPPLIER_2,
      offerKey: null,
      offerConnectionId: null,
      offerPrice: null,
    });
    const same = await h.items.update(ORG, 'i2', { supplierId: SUPPLIER, notes: 'терміново' });
    expect(same).toMatchObject({ offerKey: '45000|15', notes: 'терміново' });
  });

  // guards: BR-PL-019
  it('кількість понад кількість пропозиції — знімок лишається, відповідь позначає offerQtyExceeded', async () => {
    const h = procurementHarness({ items: [itemRow('i1', { quantity: 3, ...SNAPSHOT })] });
    h.addTable('supplierOffer', [
      {
        id: 'o-old',
        orgId: ORG,
        connectionId: CONN,
        offerKey: '45000|15',
        qty: 10,
        fetchedAt: new Date('2026-10-17T08:00:00Z'),
        deletedAt: null,
      },
      {
        id: 'o-new',
        orgId: ORG,
        connectionId: CONN,
        offerKey: '45000|15',
        qty: 4,
        fetchedAt: new Date('2026-10-18T08:00:00Z'),
        deletedAt: null,
      },
    ]);
    const within = await h.items.update(ORG, 'i1', { quantity: 4 });
    expect(within.offerQtyExceeded).toBeUndefined();
    const over = await h.items.update(ORG, 'i1', { quantity: 6 });
    expect(over).toMatchObject({ quantity: 6, offerKey: '45000|15', offerQtyExceeded: true });
  });

  // guards: BR-PL-019
  it('обмежена кількість пропозиції («≥10») — більше за межу не позначається перевищенням', async () => {
    const h = procurementHarness({ items: [itemRow('i1', { quantity: 3, ...SNAPSHOT })] });
    h.addTable('supplierOffer', [
      {
        id: 'o-cap',
        orgId: ORG,
        connectionId: CONN,
        offerKey: '45000|15',
        qty: 10,
        qtyIsLowerBound: true,
        fetchedAt: new Date('2026-10-18T08:00:00Z'),
        deletedAt: null,
      },
    ]);
    const res = await h.items.update(ORG, 'i1', { quantity: 12 });
    expect(res.offerQtyExceeded).toBeUndefined();
  });

  // guards: BR-PL-019
  it('масова зміна постачальника скидає знімок, як і PATCH; той самий постачальник — лишає', async () => {
    const h = procurementHarness({
      items: [
        itemRow('i1', { quantity: 3, ...SNAPSHOT, supplierId: SUPPLIER }),
        itemRow('i2', { quantity: 3, ...SNAPSHOT, supplierId: SUPPLIER_2 }),
        itemRow('i3', { quantity: 3, supplierId: null }),
      ],
    });
    await h.items.bulkUpdate(ORG, { itemIds: ['i1', 'i2', 'i3'], supplierId: SUPPLIER_2 });
    expect(h.item('i1')).toMatchObject({ supplierId: SUPPLIER_2, offerKey: null });
    expect(h.item('i2')).toMatchObject({ supplierId: SUPPLIER_2, offerKey: '45000|15' });
    expect(h.item('i3')).toMatchObject({ supplierId: SUPPLIER_2 });
  });
});

/** Позиція з обраною пропозицією кратністю 4 (BR-SOFR-006). */
const BY_FOUR: MemRow = { ...SNAPSHOT, offerMultiplicity: 4 };

describe('BR-SOFR-006 кратність обраної пропозиції тримається після вибору', () => {
  // guards: BR-SOFR-006, BR-PL-019
  it('зміна кількості — до кратності вгору, пропозиція лишається; інший постачальник — як є', async () => {
    const h = procurementHarness({
      items: [
        itemRow('i1', { quantity: 4, ...BY_FOUR }),
        itemRow('i2', { quantity: 4, ...BY_FOUR }),
      ],
    });
    h.addTable('supplierOffer', []);

    expect(await h.items.update(ORG, 'i1', { quantity: 5 })).toMatchObject({
      quantity: 8,
      offerKey: '45000|15',
    });
    expect(await h.items.update(ORG, 'i1', { quantity: 4 })).toMatchObject({ quantity: 4 });
    expect(await h.items.update(ORG, 'i2', { quantity: 5, supplierId: SUPPLIER_2 })).toMatchObject({
      quantity: 5,
      offerKey: null,
    });
  });

  // guards: BR-SOFR-006, BR-PL-017
  it('остача при скасуванні замовлення — відкрита частина зі знімком кратна пропозиції', async () => {
    const h = procurementHarness({
      items: [
        itemRow('i1', {
          quantity: 8,
          receivedQty: 1,
          status: 'ORDERED',
          purchaseOrderId: 'po-1',
          ...BY_FOUR,
        }),
      ],
    });

    await h.links.onOrderClosed(h.prisma as never, ORG, 'po-1');

    expect(h.item('i1')).toMatchObject({ status: 'RECEIVED', quantity: 1 });
    expect(h.liveItems().find(r => r.id !== 'i1')).toMatchObject({
      status: 'OPEN',
      quantity: 8, // недоотримано 7 → до кратності 4 вгору
      offerKey: '45000|15',
    });
  });

  // guards: BR-SOFR-006, BR-PL-013
  it('урізання за зміною наряду — до кратності вгору; неурізаний надлишок переходить на старіші', async () => {
    const h = procurementHarness({
      workOrders: [woRow(WO_A, { status: 'APPROVED' })],
      parts: [partRow('p1', WO_A, { quantity: 10 })],
      items: [
        itemRow('i-old', { quantity: 2, workOrderId: WO_A, workOrderPartId: 'p1' }),
        itemRow('i-new', { quantity: 8, workOrderId: WO_A, workOrderPartId: 'p1', ...BY_FOUR }),
      ],
    });

    await h.workOrders.updatePart(ORG, WO_A, 'p1', { quantity: 3 } as never);

    // Надлишок 7: новіша 8 → 1 → до кратності 4; решта надлишку (3) скасовує старішу (2).
    expect(h.item('i-new')).toMatchObject({ status: 'OPEN', quantity: 4, offerKey: '45000|15' });
    expect(h.item('i-old')!.status).toBe('CANCELLED');
  });

  // guards: BR-SOFR-006, BR-PL-003
  it('збільшення з наряду — сума до кратності пропозиції вгору', async () => {
    const h = procurementHarness({
      workOrders: [woRow(WO_A, { status: 'APPROVED' })],
      parts: [partRow('p1', WO_A, { quantity: 9 })],
      items: [itemRow('i1', { quantity: 4, workOrderId: WO_A, workOrderPartId: 'p1', ...BY_FOUR })],
    });

    await h.lists.fromWorkOrder(ORG, {
      workOrderId: WO_A,
      listId: 'list-1',
      parts: [{ workOrderPartId: 'p1', quantity: 1 }],
    } as never);

    expect(h.item('i1')).toMatchObject({ quantity: 8, offerKey: '45000|15' });
  });
});
