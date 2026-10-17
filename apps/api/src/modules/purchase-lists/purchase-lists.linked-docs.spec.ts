import { describe, it, expect } from 'vitest';
import {
  ORG,
  WO_A,
  WO_B,
  itemRow,
  listRow,
  partRow,
  procurementHarness,
  woRow,
} from './purchase-lists.spec-fixture';

/**
 * Зв'язки списків купівлі в обидва боки: список → наряди, замовлення, злиті списки; наряд → списки
 * його позицій. Справжні сервіси над таблицями в пам'яті.
 */

const PO = 'po-1';

function harness() {
  return procurementHarness({
    workOrders: [
      woRow(WO_A, { status: 'APPROVED' }),
      woRow(WO_B, { status: 'DRAFT', deletedAt: new Date() }),
    ],
    parts: [partRow('pa', WO_A)],
    purchaseOrders: [
      {
        id: PO,
        orgId: ORG,
        number: 'ЗП-1',
        status: 'DRAFT',
        deletedAt: null,
        createdAt: new Date(),
      },
    ],
    lists: [
      listRow('list-1'),
      listRow('list-2'),
      listRow('list-old', { status: 'CLOSED', mergedIntoId: 'list-1' }),
    ],
    items: [
      itemRow('i1', {
        listId: 'list-1',
        workOrderId: WO_A,
        purchaseOrderId: PO,
        status: 'ORDERED',
      }),
      itemRow('i2', { listId: 'list-1', workOrderId: WO_A }),
      // Видалений наряд не показується і не рахується.
      itemRow('i3', { listId: 'list-1', workOrderId: WO_B }),
      itemRow('i4', { listId: 'list-2', workOrderId: WO_A }),
    ],
  });
}

describe("Зв'язки списку купівлі", () => {
  it('список → унікальні наряди й замовлення його позицій, злиті в нього списки', async () => {
    const h = harness();

    const docs = await h.lists.getLinkedDocuments(ORG, 'list-1');

    expect(docs.workOrders.map(w => w.id)).toEqual([WO_A]);
    expect(docs.purchaseOrders.map(p => p.id)).toEqual([PO]);
    expect(docs.purchaseLists.map(l => l.id)).toEqual(['list-old']);
  });

  it('лічильники списків збігаються з деталями; чужий список — нулі', async () => {
    const h = harness();

    const counts = await h.lists.getLinkedCounts(ORG, ['list-1', 'list-2', 'foreign']);

    expect(counts['list-1']).toEqual({ workOrders: 1, purchaseOrders: 1, purchaseLists: 1 });
    expect(counts['list-2']).toEqual({ workOrders: 1, purchaseOrders: 0, purchaseLists: 0 });
    expect(counts.foreign).toEqual({ workOrders: 0, purchaseOrders: 0, purchaseLists: 0 });
  });

  it('наряд → списки купівлі його позицій (кожен один раз)', async () => {
    const h = harness();
    Object.assign(h.prisma, {
      invoice: { findMany: () => Promise.resolve([]), groupBy: () => Promise.resolve([]) },
      payment: { findMany: () => Promise.resolve([]), groupBy: () => Promise.resolve([]) },
      warranty: { findMany: () => Promise.resolve([]), groupBy: () => Promise.resolve([]) },
    });

    const docs = await h.workOrders.getLinkedDocuments(ORG, WO_A);
    const counts = await h.workOrders.getLinkedCounts(ORG, [WO_A]);

    expect(docs.purchaseLists.map(l => l.id).sort()).toEqual(['list-1', 'list-2']);
    expect(counts[WO_A].purchaseLists).toBe(2);
  });
});
