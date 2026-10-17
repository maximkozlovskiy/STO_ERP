import { describe, it, expect } from 'vitest';
import {
  GOOD,
  GOOD_2,
  ORG,
  WH,
  WO_A,
  WO_B,
  itemRow,
  partRow,
  procurementHarness,
  woRow,
} from './purchase-lists.spec-fixture';

/** Нестача по нарядах (BR-PL-014) — справжній PurchaseShortageService над таблицями в пам'яті. */

const WO_C = '61111111-1111-4111-8111-333333333333';

describe('BR-PL-014 формула нестачі', () => {
  // guards: BR-PL-014
  it('потрібно − резерв наряду − позиції рядка (OPEN + недоотримане) − пул складу', async () => {
    const h = procurementHarness({
      workOrders: [woRow(WO_A, { status: 'IN_PROGRESS' })],
      parts: [partRow('p1', WO_A, { quantity: 6 })],
      stock: { [`${GOOD}|${WH}`]: 3 },
      items: [
        itemRow('i-open', { workOrderId: WO_A, workOrderPartId: 'p1', quantity: 1 }),
        itemRow('i-ord', {
          workOrderId: WO_A,
          workOrderPartId: 'p1',
          quantity: 2,
          receivedQty: 1,
          status: 'ORDERED',
          purchaseOrderId: 'po-1',
        }),
        // Скасовані й отримані позиції нічого не покривають.
        itemRow('i-cancel', {
          workOrderId: WO_A,
          workOrderPartId: 'p1',
          quantity: 9,
          status: 'CANCELLED',
        }),
        itemRow('i-recv', {
          workOrderId: WO_A,
          workOrderPartId: 'p1',
          quantity: 9,
          receivedQty: 9,
          status: 'RECEIVED',
        }),
      ],
    });
    await h.reserveFor(WO_A, 2); // з 3 на складі вільна 1

    const { items } = await h.shortage.shortage(ORG, { limit: 50 });

    expect(items).toEqual([
      expect.objectContaining({
        workOrderId: WO_A,
        workOrderPartId: 'p1',
        required: 6,
        reserved: 2,
        inLists: 2, // 1 OPEN + 1 недоотримане
        fromPool: 1,
        shortage: 1,
        preferredSupplierId: expect.any(String),
      }),
    ]);
  });

  // guards: BR-PL-014
  it('пул (вільний залишок + ручні позиції) ділиться FIFO за plannedAt ?? createdAt', async () => {
    const h = procurementHarness({
      workOrders: [
        woRow(WO_A, { status: 'APPROVED', plannedAt: new Date('2026-10-25T08:00:00Z') }),
        // Створено пізніше, але заплановано раніше — бере пул першим.
        woRow(WO_B, { status: 'DRAFT', plannedAt: new Date('2026-10-20T08:00:00Z') }),
      ],
      parts: [partRow('pa', WO_A, { quantity: 2 }), partRow('pb', WO_B, { quantity: 2 })],
      stock: { [`${GOOD}|${WH}`]: 1 },
      items: [itemRow('manual', { quantity: 2 })], // ручна позиція без наряду → у пул
    });

    const { items } = await h.shortage.shortage(ORG, { limit: 50 });

    expect(items).toEqual([
      expect.objectContaining({ workOrderId: WO_A, fromPool: 1, shortage: 1 }),
    ]);
  });

  // guards: BR-PL-014
  it('лише невидалені наряди в активних статусах', async () => {
    const h = procurementHarness({
      workOrders: [
        woRow(WO_A, { status: 'COMPLETED' }),
        woRow(WO_B, { status: 'DRAFT', deletedAt: new Date() }),
        woRow(WO_C, { status: 'ON_HOLD' }),
      ],
      parts: [
        partRow('pa', WO_A, { quantity: 1 }),
        partRow('pb', WO_B, { quantity: 1 }),
        partRow('pc', WO_C, { quantity: 1 }),
      ],
    });

    const { items } = await h.shortage.shortage(ORG, { limit: 50 });

    expect(items.map(i => i.workOrderId)).toEqual([WO_C]);
  });

  // guards: BR-PL-014
  it('фільтр наряду рахує пул разом з іншими нарядами; limit → truncated', async () => {
    const h = procurementHarness({
      workOrders: [
        woRow(WO_A, { status: 'DRAFT', plannedAt: new Date('2026-10-20T08:00:00Z') }),
        woRow(WO_B, { status: 'DRAFT', plannedAt: new Date('2026-10-21T08:00:00Z') }),
      ],
      parts: [
        partRow('pa', WO_A, { quantity: 2 }),
        partRow('pa2', WO_A, { quantity: 1, goodId: GOOD_2 }),
        partRow('pb', WO_B, { quantity: 2 }),
      ],
      stock: { [`${GOOD}|${WH}`]: 2 },
    });

    const onlyB = await h.shortage.shortage(ORG, { workOrderId: WO_B, limit: 50 });
    expect(onlyB.items).toEqual([expect.objectContaining({ workOrderPartId: 'pb', shortage: 2 })]);

    const limited = await h.shortage.shortage(ORG, { limit: 1 });
    expect(limited).toMatchObject({ truncated: true });
    expect(limited.items).toHaveLength(1);
  });
});
