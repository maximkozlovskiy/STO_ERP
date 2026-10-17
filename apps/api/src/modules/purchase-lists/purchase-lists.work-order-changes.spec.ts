import { describe, it, expect } from 'vitest';
import {
  GOOD,
  ORG,
  WH,
  WO_A,
  itemRow,
  partRow,
  procurementHarness,
  woRow,
} from './purchase-lists.spec-fixture';

/**
 * Вплив змін наряду на позиції списків купівлі (BR-PL-013) — справжні WorkOrdersService,
 * WorkOrderStockEffectsService і PurchaseListLinkService над таблицями в пам'яті.
 */

const ordered = (id: string, over = {}) =>
  itemRow(id, {
    workOrderId: WO_A,
    workOrderPartId: 'p1',
    status: 'ORDERED',
    purchaseOrderId: 'po-1',
    source: 'WORK_ORDER',
    ...over,
  });
const open = (id: string, over = {}) =>
  itemRow(id, { workOrderId: WO_A, workOrderPartId: 'p1', source: 'WORK_ORDER', ...over });

describe('BR-PL-013 наряд скасовано, видалено або завершено', () => {
  // guards: BR-PL-013
  it('скасування: OPEN-позиції наряду → CANCELLED, ORDERED лишаються', async () => {
    const h = procurementHarness({
      workOrders: [woRow(WO_A, { status: 'APPROVED' })],
      parts: [partRow('p1', WO_A, { quantity: 3 })],
      items: [open('i-open', { quantity: 2 }), ordered('i-ord', { quantity: 1 })],
    });

    await h.workOrders.transition(ORG, WO_A, 'CANCELLED' as never);

    expect(h.item('i-open')!.status).toBe('CANCELLED');
    expect(h.item('i-ord')!.status).toBe('ORDERED');
  });

  // guards: BR-PL-013
  it('видалення чернетки: OPEN-позиції → CANCELLED', async () => {
    const h = procurementHarness({
      workOrders: [woRow(WO_A, { status: 'DRAFT' })],
      parts: [partRow('p1', WO_A, { quantity: 3 })],
      items: [open('i-open', { quantity: 3 })],
    });

    await h.workOrders.remove(ORG, WO_A, 'u');

    expect(h.item('i-open')!.status).toBe('CANCELLED');
  });

  // guards: BR-PL-013
  it('«Виконано»: OPEN-позиції → CANCELLED (товар уже списано зі складу)', async () => {
    const h = procurementHarness({
      workOrders: [woRow(WO_A, { status: 'IN_PROGRESS' })],
      parts: [partRow('p1', WO_A, { quantity: 1 })],
      stock: { [`${GOOD}|${WH}`]: 1 },
      items: [open('i-open', { quantity: 1 })],
    });

    await h.workOrders.transition(ORG, WO_A, 'COMPLETED' as never);

    expect(h.item('i-open')!.status).toBe('CANCELLED');
  });
});

describe('BR-PL-013 змінено товари наряду', () => {
  // guards: BR-PL-013
  it('кількість 5 → 2: надлишок покриття знімається з OPEN новіших першими, ORDERED не чіпаються', async () => {
    const h = procurementHarness({
      workOrders: [woRow(WO_A, { status: 'APPROVED' })],
      parts: [partRow('p1', WO_A, { quantity: 5 })],
      items: [
        ordered('i-ord', { quantity: 2, receivedQty: 1 }), // недоотримано 1
        open('i-old', { quantity: 2 }),
        open('i-new', { quantity: 2 }),
      ],
    });

    await h.workOrders.updatePart(ORG, WO_A, 'p1', { quantity: 2 } as never);

    // Покриття було 1 + 2 + 2 = 5, потреба 2 → надлишок 3: новіша (2) скасована, старша урізана до 1.
    expect(h.item('i-new')!.status).toBe('CANCELLED');
    expect(h.item('i-old')).toMatchObject({ status: 'OPEN', quantity: 1 });
    expect(h.item('i-ord')).toMatchObject({ status: 'ORDERED', quantity: 2 });
  });

  // guards: BR-PL-013
  it('резерв наряду теж рахується в покриття: зменшення не скасовує позицію, яку резерв не покриває', async () => {
    const h = procurementHarness({
      workOrders: [woRow(WO_A, { status: 'APPROVED' })],
      parts: [partRow('p1', WO_A, { quantity: 4 })],
      stock: { [`${GOOD}|${WH}`]: 2 },
      items: [open('i-open', { quantity: 2 })],
    });
    await h.reserveFor(WO_A, 2);

    await h.workOrders.updatePart(ORG, WO_A, 'p1', { quantity: 3 } as never);

    // Потреба 3 = резерв 2 + 1 з позиції.
    expect(h.item('i-open')).toMatchObject({ status: 'OPEN', quantity: 1 });
    expect(h.netOf(WO_A)).toBe(2);
  });

  // guards: BR-PL-013
  it('прибраний рядок: усі OPEN-позиції за товаром і складом → CANCELLED', async () => {
    const h = procurementHarness({
      workOrders: [woRow(WO_A, { status: 'ESTIMATE' })],
      parts: [partRow('p1', WO_A, { quantity: 2 })],
      items: [open('i-open', { quantity: 2 })],
    });

    await h.workOrders.removePart(ORG, WO_A, 'p1');

    expect(h.item('i-open')!.status).toBe('CANCELLED');
  });
});
