import { describe, it, expect } from 'vitest';
import { freeOf, pickPartWarehouse, type PickableWarehouse } from '../part-warehouse';

/**
 * BR-WO-029: склад, що підставляється в рядок товару наряду, щойно обрано товар.
 * Mutation-verify (2026-10-22): «на кількох → завжди основний» (без перевірки вільної на ньому) →
 * падає кейс «кілька, не на основному»; рахувати склади поза переліком → падає «склад поза
 * переліком»; `available >= 0` замість `> 0` → падає «основний без вільної, вільна на одному
 * іншому».
 */

const MAIN = 'wh-main';
const SIDE = 'wh-side';
const THIRD = 'wh-third';
const HOTEL = 'wh-hotel';

const list: PickableWarehouse[] = [
  { id: MAIN, isMain: true },
  { id: SIDE, isMain: false },
  { id: THIRD },
];

const free = (pairs: Array<[string, number]>) =>
  pairs.map(([warehouseId, available]) => ({ warehouseId, available }));

describe('pickPartWarehouse — BR-WO-029', () => {
  // guards: BR-WO-029
  it.each([
    ['1. вільна лише на неосновному → він', free([[SIDE, 2]]), SIDE],
    ['1. вільна лише на основному → основний', free([[MAIN, 5]]), MAIN],
    [
      '2. на кількох, зокрема на основному → основний',
      free([
        [SIDE, 9],
        [MAIN, 1],
      ]),
      MAIN,
    ],
    [
      '3. на кількох, але не на основному → порожньо',
      free([
        [SIDE, 3],
        [THIRD, 4],
      ]),
      '',
    ],
    ['4. вільної немає ніде (рядків немає) → основний', free([]), MAIN],
    [
      '4. є лише нулі (усе в резерві) → основний',
      free([
        [SIDE, 0],
        [MAIN, 0],
      ]),
      MAIN,
    ],
    [
      'основний без вільної, вільна на одному іншому → той склад',
      free([
        [MAIN, 0],
        [THIRD, 1.5],
      ]),
      THIRD,
    ],
    [
      'склад поза переліком (видалений / «Шинний готель») не рахується',
      free([
        [HOTEL, 50],
        [SIDE, 1],
      ]),
      SIDE,
    ],
    ['вільна лише поза переліком → як «немає ніде», основний', free([[HOTEL, 50]]), MAIN],
  ])('%s', (_name, byWarehouse, expected) => {
    expect(pickPartWarehouse(byWarehouse, list)).toBe(expected);
  });

  it('основного в переліку немає: «немає ніде» → порожньо, «на кількох» → порожньо', () => {
    const noMain: PickableWarehouse[] = [{ id: SIDE }, { id: THIRD }];
    expect(pickPartWarehouse(free([]), noMain)).toBe('');
    expect(
      pickPartWarehouse(
        free([
          [SIDE, 1],
          [THIRD, 1],
        ]),
        noMain,
      ),
    ).toBe('');
    expect(pickPartWarehouse(free([[THIRD, 1]]), noMain)).toBe(THIRD);
  });
});

describe('freeOf — вільна кількість рядка складу', () => {
  it('бере available з відповіді', () => {
    expect(freeOf({ warehouseId: SIDE, quantity: 10, reserved: 4, available: 6 })).toBe(6);
  });

  it('відповідь без available (стара збірка API) → quantity − reserved, не менше нуля', () => {
    expect(freeOf({ warehouseId: SIDE, quantity: 10, reserved: 4 })).toBe(6);
    expect(freeOf({ warehouseId: SIDE, quantity: 2, reserved: 5 })).toBe(0);
    expect(freeOf({ warehouseId: SIDE, quantity: 3 })).toBe(3);
  });

  // guards: BR-WO-029
  it('float-дрейф залишку (сума рухів) — не вільна кількість: склад з підписом «0» не обирається', () => {
    const drift = freeOf({ warehouseId: SIDE, quantity: 2.2 + 0.1, reserved: 2.3 });
    expect(drift).toBe(0);
    expect(freeOf({ warehouseId: SIDE, quantity: 0.3, reserved: 0.1 })).toBe(0.2);
    expect(freeOf({ warehouseId: SIDE, quantity: 1, reserved: 0, available: 1e-16 })).toBe(0);
    // Без округлення SIDE мав би «вільну» 4e-16 і підставився б замість основного.
    expect(pickPartWarehouse([{ warehouseId: SIDE, available: drift }], list)).toBe(MAIN);
  });
});
