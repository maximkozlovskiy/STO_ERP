import { describe, it, expect } from 'vitest';
import {
  GOOD,
  ORG,
  UOM_PACK,
  WH,
  WH_2,
  WO_A,
  WO_B,
  partRow,
  stockHarness,
  woRow,
} from './work-order-stock.spec-fixture';

/**
 * Життєвий цикл резерву наряду (BR-WO-021, BR-INVT-018) — справжні WorkOrdersService,
 * WorkOrderStockEffectsService і InventoryService над таблицями в пам'яті. Резерв може з'явитись
 * до «В роботі» (приймання від постачальника, BR-PL-011) — тут він робиться тим самим рухом
 * RESERVATION з documentType 'WorkOrder' (`reserveFor`).
 */

describe('BR-WO-021 «В роботу»: дорезервування лише бракуючого', () => {
  // guards: BR-WO-021
  it('частина вже зарезервована при прийманні — дорезервовується лише решта, без подвоєння', async () => {
    const h = stockHarness({
      workOrders: [woRow(WO_A, { status: 'APPROVED' })],
      parts: [partRow('p1', WO_A, { quantity: 3 })],
      stock: { [`${GOOD}|${WH}`]: 10 },
    });
    await h.reserveFor(WO_A, 1);

    await h.service.transition(ORG, WO_A, 'IN_PROGRESS' as never);

    expect(h.netOf(WO_A)).toBe(3);
    expect(h.reserved()).toBe(3);
  });

  // guards: BR-WO-021
  it('нестача не блокує перехід: резервується наявне, решта лишається нестачею', async () => {
    const h = stockHarness({
      workOrders: [woRow(WO_A, { status: 'APPROVED' })],
      parts: [partRow('p1', WO_A, { quantity: 5 })],
      stock: { [`${GOOD}|${WH}`]: 2 },
    });

    await h.service.transition(ORG, WO_A, 'IN_PROGRESS' as never);

    expect(h.status(WO_A)).toBe('IN_PROGRESS');
    expect(h.netOf(WO_A)).toBe(2);
  });

  // guards: BR-WO-021
  it('чужий резерв не береться: available = залишок − резерв інших нарядів', async () => {
    const h = stockHarness({
      workOrders: [woRow(WO_A, { status: 'APPROVED' }), woRow(WO_B, { status: 'IN_PROGRESS' })],
      parts: [partRow('p1', WO_A, { quantity: 4 })],
      stock: { [`${GOOD}|${WH}`]: 5 },
    });
    await h.reserveFor(WO_B, 3);

    await h.service.transition(ORG, WO_A, 'IN_PROGRESS' as never);

    expect(h.netOf(WO_A)).toBe(2);
    expect(h.netOf(WO_B)).toBe(3);
    expect(h.reserved()).toBe(5);
  });

  // guards: BR-WO-021
  it('«Призупинено» → «В роботі»: повторний вхід дорезервовує те, що надійшло, і не подвоює', async () => {
    const h = stockHarness({
      workOrders: [woRow(WO_A, { status: 'APPROVED' })],
      parts: [partRow('p1', WO_A, { quantity: 4 })],
      stock: { [`${GOOD}|${WH}`]: 1 },
    });
    await h.service.transition(ORG, WO_A, 'IN_PROGRESS' as never);
    await h.service.transition(ORG, WO_A, 'ON_HOLD' as never);
    h.item()!.quantity = 10; // товар надійшов, поки наряд стояв

    await h.service.transition(ORG, WO_A, 'IN_PROGRESS' as never);
    await h.service.transition(ORG, WO_A, 'ON_HOLD' as never);
    await h.service.transition(ORG, WO_A, 'IN_PROGRESS' as never);

    expect(h.netOf(WO_A)).toBe(4);
    expect(h.reserved()).toBe(4);
  });

  // guards: BR-WO-021
  it('потреба в базових одиницях: 2 пакети × 6 шт → резерв 12', async () => {
    const h = stockHarness({
      workOrders: [woRow(WO_A, { status: 'APPROVED' })],
      parts: [partRow('p1', WO_A, { quantity: 2, unitOfMeasureId: UOM_PACK })],
      stock: { [`${GOOD}|${WH}`]: 20 },
      goodUoMs: [{ orgId: ORG, goodId: GOOD, unitOfMeasureId: UOM_PACK, coefficient: 6 }],
    });

    await h.service.transition(ORG, WO_A, 'IN_PROGRESS' as never);

    expect(h.netOf(WO_A)).toBe(12);
  });
});

describe('BR-WO-021 скасування й видалення: знімається весь net-резерв', () => {
  // guards: BR-WO-021
  // IN_PROGRESS → CANCELLED FSM не дозволяє (лише через «Призупинено»).
  it.each(['DRAFT', 'ESTIMATE', 'APPROVED', 'ON_HOLD'])(
    'скасування з %s знімає весь net-резерв наряду і не чіпає чужий',
    async from => {
      const h = stockHarness({
        workOrders: [woRow(WO_A, { status: from }), woRow(WO_B, { status: 'IN_PROGRESS' })],
        parts: [partRow('p1', WO_A, { quantity: 3 })],
        stock: { [`${GOOD}|${WH}`]: 10, [`${GOOD}|${WH_2}`]: 5 },
      });
      await h.reserveFor(WO_A, 3);
      // Резерв за рядком, якого вже немає (інший склад), — теж знімається.
      await h.reserveFor(WO_A, 2, GOOD, WH_2);
      await h.reserveFor(WO_B, 4);

      await h.service.transition(ORG, WO_A, 'CANCELLED' as never);

      expect(h.status(WO_A)).toBe('CANCELLED');
      expect(h.netOf(WO_A)).toBe(0);
      expect(h.netOf(WO_A, GOOD, WH_2)).toBe(0);
      expect(h.netOf(WO_B)).toBe(4);
      expect(h.reserved()).toBe(4);
      expect(h.reserved(GOOD, WH_2)).toBe(0);
    },
  );

  // guards: BR-WO-021
  it('видалення чернетки з резервом отриманого знімає резерв', async () => {
    const h = stockHarness({
      workOrders: [woRow(WO_A, { status: 'DRAFT' })],
      parts: [partRow('p1', WO_A, { quantity: 2 })],
      stock: { [`${GOOD}|${WH}`]: 5 },
    });
    await h.reserveFor(WO_A, 2);

    await h.service.remove(ORG, WO_A, 'u');

    expect(h.tables.workOrder.rows[0].deletedAt).not.toBeNull();
    expect(h.netOf(WO_A)).toBe(0);
    expect(h.reserved()).toBe(0);
  });
});

describe('BR-WO-021 правка товарів: надлишок резерву знімається', () => {
  // guards: BR-WO-021
  it('зменшення кількості 5 → 2 знімає 3 з резерву; наряд блокується ДО руху складу', async () => {
    const h = stockHarness({
      workOrders: [woRow(WO_A, { status: 'APPROVED' })],
      parts: [partRow('p1', WO_A, { quantity: 5 })],
      stock: { [`${GOOD}|${WH}`]: 10 },
    });
    await h.reserveFor(WO_A, 5);
    h.events.length = 0;

    await h.service.updatePart(ORG, WO_A, 'p1', { quantity: 2 } as never);

    expect(h.netOf(WO_A)).toBe(2);
    expect(h.reserved()).toBe(2);
    // Порядок блокувань «наряд → склад» (як у transition і прийманні).
    expect(h.events).toEqual([`lock:${WO_A}`, `RESERVATION_RELEASE:${GOOD}`]);
  });

  // guards: BR-WO-021
  it('зміна одиниці на меншу (пакет 6 → штука) знімає надлишок у базових одиницях', async () => {
    const h = stockHarness({
      workOrders: [woRow(WO_A, { status: 'DRAFT' })],
      parts: [partRow('p1', WO_A, { quantity: 1, unitOfMeasureId: UOM_PACK })],
      stock: { [`${GOOD}|${WH}`]: 10 },
      goodUoMs: [{ orgId: ORG, goodId: GOOD, unitOfMeasureId: UOM_PACK, coefficient: 6 }],
    });
    await h.reserveFor(WO_A, 6);
    // Рядок переведено на базову одиницю: потреба 1, а не 6.
    h.tables.workOrderPart.rows[0].unitOfMeasureId = null;

    await h.stockEffects.reconcileAfterPartsChange(ORG, WO_A);

    expect(h.netOf(WO_A)).toBe(1);
  });

  // guards: BR-WO-021
  it('видалення рядка знімає його резерв; збільшення кількості резерву не додає', async () => {
    const h = stockHarness({
      workOrders: [woRow(WO_A, { status: 'ESTIMATE' })],
      parts: [
        partRow('p1', WO_A, { quantity: 2 }),
        partRow('p2', WO_A, { quantity: 1, goodId: 'g-x' }),
      ],
      stock: { [`${GOOD}|${WH}`]: 10 },
    });
    await h.reserveFor(WO_A, 2);

    await h.service.updatePart(ORG, WO_A, 'p1', { quantity: 7 } as never);
    expect(h.netOf(WO_A)).toBe(2);

    await h.service.removePart(ORG, WO_A, 'p1');
    expect(h.netOf(WO_A)).toBe(0);
    expect(h.reserved()).toBe(0);
  });
});

describe('BR-WO-021 «Виконано»: після списання рядків залишок net-резерву знімається', () => {
  // guards: BR-WO-021
  it('резерв на іншому складі без рядка (приймання на інший склад) не «зависає»', async () => {
    const h = stockHarness({
      workOrders: [woRow(WO_A, { status: 'IN_PROGRESS' })],
      parts: [partRow('p1', WO_A, { quantity: 2 })],
      stock: { [`${GOOD}|${WH}`]: 5, [`${GOOD}|${WH_2}`]: 3 },
    });
    await h.reserveFor(WO_A, 2);
    await h.reserveFor(WO_A, 3, GOOD, WH_2);

    await h.service.transition(ORG, WO_A, 'COMPLETED' as never);

    expect(h.netOf(WO_A)).toBe(0);
    expect(h.netOf(WO_A, GOOD, WH_2)).toBe(0);
    expect(h.reserved(GOOD, WH_2)).toBe(0);
    expect(h.item()!.quantity).toBe(3); // списано 2 з 5
    expect(h.item(GOOD, WH_2)!.quantity).toBe(3); // фізичний залишок іншого складу не чіпали
  });
});
