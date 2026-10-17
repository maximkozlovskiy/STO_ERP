import { describe, it, expect } from 'vitest';
import {
  GOOD,
  ORG,
  SUPPLIER,
  UOM_PACK,
  WH,
  WO_A,
  WO_B,
  itemRow,
  listRow,
  partRow,
  procurementHarness,
  woRow,
} from './purchase-lists.spec-fixture';

/**
 * «До списку купівлі» з наряду (BR-PL-003), нумерація (BR-PL-001), базові одиниці (BR-PL-002) —
 * справжній PurchaseListsService над таблицями в пам'яті.
 */

const send = (
  h: ReturnType<typeof procurementHarness>,
  parts: Array<{ workOrderPartId: string; quantity?: number }>,
  target: { listId?: string } = {},
) => h.lists.fromWorkOrder(ORG, { workOrderId: WO_A, parts, ...target } as never);

function harness(opts: Parameters<typeof procurementHarness>[0] = {}) {
  return procurementHarness({
    workOrders: [woRow(WO_A, { status: 'APPROVED' }), woRow(WO_B, { status: 'DRAFT' })],
    parts: [partRow('p1', WO_A, { quantity: 3 }), partRow('p-b', WO_B, { quantity: 1 })],
    stock: { [`${GOOD}|${WH}`]: 1 },
    ...opts,
  });
}

describe('BR-PL-003 надсилання товарів із наряду', () => {
  // guards: BR-PL-003
  it('кількість за замовчуванням — непокрита потреба; постачальник — бажаний товару', async () => {
    const h = harness();

    const res = await send(h, [{ workOrderPartId: 'p1' }]);

    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      quantity: 2, // потрібно 3, вільний залишок 1
      source: 'WORK_ORDER',
      status: 'OPEN',
      workOrderId: WO_A,
      workOrderPartId: 'p1',
      supplierId: SUPPLIER,
      warehouseId: WH,
    });
    expect(res.list.status).toBe('OPEN');
  });

  // guards: BR-PL-003
  it('рядок, повторений у тілі, не бере непокриту потребу вдруге → 400, нічого не записано', async () => {
    const h = harness();

    await expect(send(h, [{ workOrderPartId: 'p1' }, { workOrderPartId: 'p1' }])).rejects.toThrow(
      /покрит/i,
    );
    expect(h.liveItems()).toHaveLength(0);
  });

  // guards: BR-PL-015 (§2.1: очікувана ціна — закупівельна)
  it('приймальня не бачить очікуваної ціни позицій у відповіді; комірник бачить', async () => {
    const h = harness();
    const res = await send(h, [{ workOrderPartId: 'p1' }]);
    await h.items.update(ORG, res.items[0].id, { expectedPrice: 40 } as never);

    const asReception = await h.lists.findOne(ORG, res.list.id, 'RECEPTIONIST');
    const asMechanic = await h.items.byWorkOrder(ORG, WO_A, 'MECHANIC');
    const asStorekeeper = await h.lists.findOne(ORG, res.list.id, 'STOREKEEPER');

    expect(asReception.items[0].expectedPrice).toBeNull();
    expect(asMechanic.items[0].expectedPrice).toBeNull();
    expect(asStorekeeper.items[0].expectedPrice).toBe(40);
  });

  // guards: BR-PL-003
  it('повторне надсилання: покрито → 400; явна кількість збільшує ту саму OPEN-позицію', async () => {
    const h = harness();
    const first = await send(h, [{ workOrderPartId: 'p1' }]);
    const listId = first.list.id;

    await expect(send(h, [{ workOrderPartId: 'p1' }], { listId })).rejects.toThrow(/уже покритий/);
    const again = await send(h, [{ workOrderPartId: 'p1', quantity: 1 }], { listId });

    expect(again.items[0].id).toBe(first.items[0].id);
    expect(again.items[0].quantity).toBe(3);
    expect(h.liveItems()).toHaveLength(1);
  });

  // guards: BR-PL-003
  it('рядок чужого наряду → 400 partNotFound, нічого не створено', async () => {
    const h = harness();

    await expect(send(h, [{ workOrderPartId: 'p-b' }])).rejects.toThrow(/p-b/);

    expect(h.liveItems()).toHaveLength(0);
    expect(h.tables.purchaseList.rows).toHaveLength(1); // лише список із fixture
  });

  // guards: BR-PL-003
  it.each(['COMPLETED', 'CANCELLED', 'INVOICED'])('наряд у статусі %s → 400', async status => {
    const h = harness({
      workOrders: [woRow(WO_A, { status })],
      parts: [partRow('p1', WO_A, { quantity: 3 })],
    });
    await expect(send(h, [{ workOrderPartId: 'p1' }])).rejects.toThrow(/закрито або скасовано/);
  });

  // guards: BR-PL-003
  it('видалений наряд → 404; закритий цільовий список → 400 listNotOpen', async () => {
    const h = harness({
      lists: [listRow('list-closed', { status: 'CLOSED' })],
    });
    await expect(send(h, [{ workOrderPartId: 'p1' }], { listId: 'list-closed' })).rejects.toThrow(
      /закрито або скасовано — змінювати/,
    );
    h.tables.workOrder.rows[0].deletedAt = new Date();
    await expect(send(h, [{ workOrderPartId: 'p1' }])).rejects.toThrow(/Наряд не знайдено/);
  });

  // guards: BR-PL-003
  it('наряд блокується (FOR UPDATE) у транзакції надсилання', async () => {
    const h = harness();
    await send(h, [{ workOrderPartId: 'p1' }]);
    expect(h.locks).toContainEqual([WO_A]);
  });
});

describe('BR-PL-001 нумерація списку', () => {
  // guards: BR-PL-001
  it('новий список — номер PURCHASE_LIST, узятий ДО транзакції', async () => {
    const h = harness();
    const res = await send(h, [{ workOrderPartId: 'p1' }]);

    expect(h.docNumbers.next).toHaveBeenCalledWith(ORG, 'PURCHASE_LIST');
    expect(res.list.number).toBe('СК-2026-000001');
    const tx = (
      h.prisma as unknown as { $transaction: { mock: { invocationCallOrder: number[] } } }
    ).$transaction;
    expect(h.docNumbers.next.mock.invocationCallOrder[0]).toBeLessThan(
      tx.mock.invocationCallOrder[0],
    );
  });

  // guards: BR-PL-001
  it('POST /purchase-lists теж нумерує через PURCHASE_LIST', async () => {
    const h = harness();
    const created = await h.lists.create(ORG, { name: 'Тиждень 42' } as never);
    expect(created).toMatchObject({ number: 'СК-2026-000001', name: 'Тиждень 42', status: 'OPEN' });
  });
});

describe('BR-PL-002 базові одиниці', () => {
  // guards: BR-PL-002
  it('рядок у пакетах (× 6): позиція в базових — 2 пакети → 12', async () => {
    const h = harness({
      parts: [partRow('p1', WO_A, { quantity: 2, unitOfMeasureId: UOM_PACK })],
      stock: {},
      goodUoMs: [{ orgId: ORG, goodId: GOOD, unitOfMeasureId: UOM_PACK, coefficient: 6 }],
    });

    const res = await send(h, [{ workOrderPartId: 'p1' }]);

    expect(res.items[0].quantity).toBe(12);
  });

  // guards: BR-PL-002
  it('нестача рядка в картці наряду — у базових одиницях і з базовою одиницею товару (Bug #886)', async () => {
    const h = harness({
      parts: [partRow('p1', WO_A, { quantity: 1.5, unitOfMeasureId: UOM_PACK })],
      stock: {},
      goodUoMs: [{ orgId: ORG, goodId: GOOD, unitOfMeasureId: UOM_PACK, coefficient: 4 }],
    });

    const res = await h.items.byWorkOrder(ORG, WO_A, 'RECEPTIONIST');

    // 1.5 пакета × 4 = 6 штук: підпис — «шт» товару, а не «пак» рядка.
    expect(res.shortage).toEqual([{ workOrderPartId: 'p1', shortage: 6, goodUnit: 'шт' }]);
  });
});

describe('BR-PL-015 позиції наряду в його картці', () => {
  // guards: BR-PL-015
  it('позиції наряду без скасованих, найстаріші першими; нестача — поруч', async () => {
    const h = harness({
      items: [
        itemRow('i-cancel', { workOrderId: WO_A, workOrderPartId: 'p1', status: 'CANCELLED' }),
        itemRow('i-old', { workOrderId: WO_A, workOrderPartId: 'p1', quantity: 1 }),
        itemRow('i-new', { workOrderId: WO_A, workOrderPartId: 'p1', quantity: 1 }),
        itemRow('i-other', { workOrderId: WO_B, workOrderPartId: 'p-b' }),
      ],
    });

    const res = await h.items.byWorkOrder(ORG, WO_A, 'STOREKEEPER');

    expect(res.items.map(i => i.id)).toEqual(['i-old', 'i-new']);
    // Потреба 3: склад 1 + позиції 2 → нестачі немає.
    expect(res.shortage).toEqual([]);
  });

  // guards: BR-PL-015
  it('наряд без позицій (лише скасовані) — порожньо, позиції зі зв’язками не читаються', async () => {
    const h = harness({
      stock: {},
      items: [
        itemRow('i-cancel', { workOrderId: WO_A, workOrderPartId: 'p1', status: 'CANCELLED' }),
      ],
    });
    h.tables.purchaseListItem.findMany.mockClear();

    const res = await h.items.byWorkOrder(ORG, WO_A, 'MECHANIC');

    expect(res.items).toEqual([]);
    expect(res.shortage).toEqual([{ workOrderPartId: 'p1', shortage: 3, goodUnit: 'шт' }]);
    // sto-optimize: лічильник позицій — разом із перевіркою наряду; `findMany` з `include` шле
    // запит на кожен зв'язок навіть на порожньому результаті. Лишається лише читання нестачі.
    expect(
      h.tables.purchaseListItem.findMany.mock.calls.filter(
        ([args]) => (args as { include?: unknown }).include,
      ),
    ).toHaveLength(0);
  });

  // guards: BR-PL-015
  it('видалений або чужий наряд → 404', async () => {
    const h = harness({
      workOrders: [
        woRow(WO_A, { status: 'APPROVED', deletedAt: new Date() }),
        woRow(WO_B, { status: 'DRAFT', orgId: '00000000-0000-4000-8000-00000000f0f0' }),
      ],
    });

    await expect(h.items.byWorkOrder(ORG, WO_A, 'MECHANIC')).rejects.toThrow(/не знайдено/i);
    await expect(h.items.byWorkOrder(ORG, WO_B, 'MECHANIC')).rejects.toThrow(/не знайдено/i);
  });
});
