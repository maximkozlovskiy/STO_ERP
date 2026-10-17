import { describe, it, expect } from 'vitest';
import {
  CLIENT_ONLY,
  GOOD,
  GOOD_2,
  ORG,
  SUPPLIER,
  WH,
  WH_2,
  itemRow,
  listRow,
  procurementHarness,
} from './purchase-lists.spec-fixture';

/**
 * Ручні позиції (BR-PL-004), зміна лише OPEN-позицій (BR-PL-005), об'єднання (BR-PL-006),
 * перенесення й розділення (BR-PL-007) — справжні сервіси над таблицями в пам'яті.
 */

describe('BR-PL-004 ручна позиція', () => {
  // guards: BR-PL-004
  it('позиція MANUAL без наряду, у базових одиницях; постачальник необов’язковий', async () => {
    const h = procurementHarness();
    const item = await h.lists.addItem(ORG, 'list-1', {
      goodId: GOOD_2,
      warehouseId: WH_2,
      quantity: 4,
    } as never);
    expect(item).toMatchObject({
      source: 'MANUAL',
      workOrderId: null,
      supplierId: null,
      quantity: 4,
      warehouseName: 'Другий склад',
    });
  });

  // guards: BR-PL-004
  it('клієнт як постачальник → 400; чужий склад → 404; закритий список → 400', async () => {
    const h = procurementHarness({
      lists: [listRow('list-1'), listRow('list-c', { status: 'CLOSED' })],
    });
    const dto = { goodId: GOOD, warehouseId: WH, quantity: 1 };
    await expect(
      h.lists.addItem(ORG, 'list-1', { ...dto, supplierId: CLIENT_ONLY } as never),
    ).rejects.toThrow();
    await expect(
      h.lists.addItem(ORG, 'list-1', { ...dto, warehouseId: 'wh-foreign' } as never),
    ).rejects.toThrow(/Склад не знайдено/);
    await expect(h.lists.addItem(ORG, 'list-c', dto as never)).rejects.toThrow(/закрито/);
    expect(h.liveItems()).toHaveLength(0);
  });
});

describe('BR-PL-005 змінюється лише OPEN-позиція', () => {
  // guards: BR-PL-005
  it.each(['ORDERED', 'RECEIVED', 'CANCELLED'])('позиція %s → 400 itemNotOpen', async status => {
    const h = procurementHarness({ items: [itemRow('i1', { status })] });
    await expect(h.items.update(ORG, 'i1', { quantity: 2 } as never)).rejects.toThrow(
      /незамовлені позиції/,
    );
    await expect(h.items.bulkCancel(ORG, { itemIds: ['i1'] })).rejects.toThrow(
      /незамовлені позиції/,
    );
  });

  // guards: BR-PL-005
  it('паралельна зміна між читанням і записом → 409, позиція не змінена', async () => {
    const h = procurementHarness({ items: [itemRow('i1', { quantity: 5 })] });
    const findFirst = h.tables.purchaseListItem.findFirst;
    findFirst.mockImplementationOnce(async args => {
      // Prisma віддає копію рядка — сервіс тримає прочитане значення.
      const row = { ...(await findFirst.getMockImplementation()!(args)) };
      h.item('i1')!.quantity = 7; // хтось інший змінив кількість
      return row;
    });

    await expect(h.items.update(ORG, 'i1', { quantity: 1 } as never)).rejects.toThrow(
      /змінено іншим користувачем/,
    );
    expect(h.item('i1')!.quantity).toBe(7);
  });

  // guards: BR-PL-005
  it('масово: постачальник і ціна OPEN-позицій', async () => {
    const h = procurementHarness({ items: [itemRow('i1'), itemRow('i2')] });
    const res = await h.items.bulkUpdate(ORG, {
      itemIds: ['i1', 'i2'],
      supplierId: SUPPLIER,
      expectedPrice: 12.5,
    } as never);
    expect(res.count).toBe(2);
    expect(h.item('i2')).toMatchObject({ supplierId: SUPPLIER, expectedPrice: 12.5 });
  });
});

describe('BR-PL-006 об’єднання списків', () => {
  // guards: BR-PL-006
  it('позиції джерел (будь-якого статусу) → у ціль; джерела CLOSED з mergedIntoId', async () => {
    const h = procurementHarness({
      lists: [listRow('list-t'), listRow('list-s1'), listRow('list-s2')],
      items: [
        itemRow('i1', { listId: 'list-s1' }),
        itemRow('i2', {
          listId: 'list-s2',
          status: 'ORDERED',
          purchaseOrderId: 'po-1',
          warehouseId: WH_2,
        }),
        itemRow('i3', { listId: 'list-t' }),
      ],
    });

    const merged = await h.lists.merge(ORG, {
      targetListId: 'list-t',
      sourceListIds: ['list-s1', 'list-s2'],
    });

    expect(merged.items.map(i => i.id).sort()).toEqual(['i1', 'i2', 'i3']);
    for (const id of ['list-s1', 'list-s2']) {
      expect(h.list(id)).toMatchObject({ status: 'CLOSED', mergedIntoId: 'list-t' });
      expect(h.list(id)!.closedAt).toBeInstanceOf(Date);
    }
    expect(h.list('list-t')!.status).toBe('OPEN');
  });

  // guards: BR-PL-006
  it('ціль серед джерел → 400; закрите джерело → 400, нічого не змінено', async () => {
    const h = procurementHarness({
      lists: [listRow('list-t'), listRow('list-s', { status: 'CLOSED' })],
      items: [itemRow('i1', { listId: 'list-s' })],
    });
    await expect(
      h.lists.merge(ORG, { targetListId: 'list-t', sourceListIds: ['list-t'] }),
    ).rejects.toThrow(/сам із собою/);
    await expect(
      h.lists.merge(ORG, { targetListId: 'list-t', sourceListIds: ['list-s'] }),
    ).rejects.toThrow(/закрито/);
    expect(h.item('i1')!.listId).toBe('list-s');
  });
});

describe('BR-PL-007 перенесення й розділення', () => {
  // guards: BR-PL-007
  it('розділення: 5 → 3 + 2, нова позиція з тими самими зв’язками', async () => {
    const h = procurementHarness({
      items: [
        itemRow('i1', {
          quantity: 5,
          workOrderId: 'wo-x',
          workOrderPartId: 'part-x',
          supplierId: SUPPLIER,
          expectedPrice: 10,
          source: 'WORK_ORDER',
        }),
      ],
    });

    const [orig, part] = await h.items.split(ORG, 'i1', { quantity: 2 });

    expect(orig.quantity).toBe(3);
    expect(part).toMatchObject({
      quantity: 2,
      status: 'OPEN',
      workOrderPartId: 'part-x',
      supplierId: SUPPLIER,
      expectedPrice: 10,
      source: 'WORK_ORDER',
    });
  });

  // guards: BR-PL-007
  it.each([0, 5, 7])('розділення на %s із 5 → 400', async qty => {
    const h = procurementHarness({ items: [itemRow('i1', { quantity: 5 })] });
    await expect(h.items.split(ORG, 'i1', { quantity: qty })).rejects.toThrow(/розділення/);
  });

  // guards: BR-PL-007
  it('перенесення в новий список; у той самий → 400; ORDERED не переноситься', async () => {
    const h = procurementHarness({
      items: [
        itemRow('i1'),
        itemRow('i2'),
        itemRow('i3', { status: 'ORDERED', purchaseOrderId: 'po-1' }),
      ],
    });
    await expect(
      h.items.move(ORG, { itemIds: ['i1'], targetListId: 'list-1' } as never),
    ).rejects.toThrow(/вже в цьому списку/);
    await expect(
      h.items.move(ORG, { itemIds: ['i1', 'i3'], newListName: 'Б' } as never),
    ).rejects.toThrow(/незамовлені/);

    await h.items.move(ORG, { itemIds: ['i1', 'i2'], newListName: 'Терміново' } as never);

    const target = h.tables.purchaseList.rows.find(l => l.name === 'Терміново')!;
    expect(h.item('i1')!.listId).toBe(target.id);
    expect(h.item('i2')!.listId).toBe(target.id);
    expect(h.item('i3')!.listId).toBe('list-1');
  });
});
