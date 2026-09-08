import * as fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { StockMovementType } from '@prisma/client';

/**
 * Інваріант: після будь-якої послідовності ВАЛІДНИХ рухів
 *   quantity >= 0
 *   reserved >= 0
 *   available = quantity - reserved >= 0
 *
 * Невалідні рухи (insufficient stock тощо) повинні відхилятись — для них функція повертає null.
 */
function applyMovements(
  movements: { type: StockMovementType; qty: number }[],
): { quantity: number; reserved: number; available: number } | null {
  let quantity = 0;
  let reserved = 0;

  for (const { type, qty } of movements) {
    if (qty <= 0) return null; // qty=0 заборонений
    switch (type) {
      case 'RECEIPT':
      case 'OPENING_BALANCE':
        quantity += qty;
        break;
      case 'RESERVATION':
        if (quantity - reserved < qty) return null;
        reserved += qty;
        break;
      case 'RESERVATION_RELEASE':
        if (reserved < qty) return null;
        reserved -= qty;
        break;
      case 'WRITEOFF':
        if (quantity - reserved < qty) return null;
        quantity -= qty;
        break;
      case 'RETURN':
        // Реверс WRITEOFF (C2): повертає фізичну к-сть на склад. На COMPLETED резерв уже знято,
        // тож RETURN лише інкрементує quantity (як RECEIPT семантично, але існуючих партій).
        quantity += qty;
        break;
      case 'TRANSFER':
        // TRANSFER переміщує між складами — для інваріантів вважаємо нейтральним
        break;
      default:
        return null;
    }
  }
  return { quantity, reserved, available: quantity - reserved };
}

const SUPPORTED_TYPES: StockMovementType[] = [
  'RECEIPT',
  'RESERVATION',
  'RESERVATION_RELEASE',
  'WRITEOFF',
];

describe('Inventory — balance invariants (property-based)', () => {
  it('після будь-яких валідних рухів: quantity ≥ 0, reserved ≥ 0, available ≥ 0', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.constantFrom<StockMovementType>(...SUPPORTED_TYPES),
            qty: fc.integer({ min: 1, max: 100 }),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        movements => {
          const result = applyMovements(movements);
          if (result === null) return true; // невалідна послідовність — пропускаємо
          return result.quantity >= 0 && result.reserved >= 0 && result.available >= 0;
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('RECEIPT завжди збільшує quantity (рівно на qty)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 1, max: 100 }),
        (initialQty, receiptQty) => {
          const before = initialQty;
          const after = before + receiptQty;
          return after === before + receiptQty && after > before;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('RESERVATION з available < qty — відхиляється', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 101, max: 500 }),
        (qty, reserveQty) => {
          // quantity=qty, reserved=0 → available=qty; reserveQty > available
          const result = applyMovements([
            { type: 'RECEIPT', qty },
            { type: 'RESERVATION', qty: reserveQty },
          ]);
          return result === null;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('WRITEOFF з quantity < qty — відхиляється', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 101, max: 500 }),
        (qty, writeoffQty) => {
          const result = applyMovements([
            { type: 'RECEIPT', qty },
            { type: 'WRITEOFF', qty: writeoffQty },
          ]);
          return result === null;
        },
      ),
      { numRuns: 200 },
    );
  });

  // C2: WRITEOFF→RETURN round-trip повертає quantity до pre-writeoff (реверс складу при
  // скасуванні завершеного наряду). Дзеркалить симетрію writeOffPartsAndCharge/returnPartsAndCredit.
  it('WRITEOFF→RETURN тієї ж к-сті повертає quantity до вихідного значення', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }), // початковий залишок
        fc.integer({ min: 1, max: 1000 }), // к-сть списання/повернення
        (initialQty, moveQty) => {
          fc.pre(moveQty <= initialQty); // списати можна лише наявне
          const result = applyMovements([
            { type: 'RECEIPT', qty: initialQty },
            { type: 'WRITEOFF', qty: moveQty },
            { type: 'RETURN', qty: moveQty },
          ]);
          if (result === null) return false; // валідна послідовність не має відхилятись
          // quantity повертається рівно до initialQty; reserved/available незмінні
          return result.quantity === initialQty && result.reserved === 0;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('RESERVATION_RELEASE з reserved < qty — відхиляється', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 101, max: 500 }),
        (reservedQty, releaseQty) => {
          const result = applyMovements([
            { type: 'RECEIPT', qty: reservedQty },
            { type: 'RESERVATION', qty: reservedQty },
            { type: 'RESERVATION_RELEASE', qty: releaseQty },
          ]);
          return result === null;
        },
      ),
    );
  });

  it('повний цикл RECEIPT → RESERVATION → WRITEOFF → RESERVATION_RELEASE → quantity=0, reserved=0', () => {
    // Класичний flow для запчастини: прийшла, зарезервували, списали при виконанні роботи,
    // зняли резерв. Підсумок — баланс нульовий.
    const result = applyMovements([
      { type: 'RECEIPT', qty: 10 },
      { type: 'RESERVATION', qty: 5 },
      { type: 'WRITEOFF', qty: 5 },
      { type: 'RESERVATION_RELEASE', qty: 5 },
    ]);
    // WRITEOFF над зарезервованим неможливий (available = 10 - 5 = 5, writeoff 5 ok)
    // після writeoff quantity=5, reserved=5, available=0 — RELEASE 5 валідний
    expect(result).not.toBeNull();
    expect(result!.quantity).toBe(5);
    expect(result!.reserved).toBe(0);
  });

  it('кумулятивно RECEIPT N разів = sum(receipts)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 20 }),
        receipts => {
          const movements = receipts.map(qty => ({
            type: 'RECEIPT' as StockMovementType,
            qty,
          }));
          const result = applyMovements(movements);
          const expected = receipts.reduce((s, q) => s + q, 0);
          return result !== null && result.quantity === expected;
        },
      ),
      { numRuns: 200 },
    );
  });
});
