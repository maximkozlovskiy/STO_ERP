import { describe, it, expect } from 'vitest';
import {
  freeOf,
  pickPartWarehouse,
  pickServicePartWarehouse,
  type PickableWarehouse,
} from '../part-warehouse';

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

/**
 * BR-WO-038: склад запчастини, доданої послугою, — склад філії наряду з найбільшою вільною
 * кількістю, інакше основний склад філії, інакше перший склад філії (тип MAIN, далі будь-який).
 * Mutation-verify (2026-10-31): без фільтра за філією → червоніє «склад іншої філії»; перший склад
 * з вільною замість найбільшої → червоніє «найбільша»; без запасного MAIN → червоніє «основного
 * у філії немає»; `free === null` як «немає складу» → червоніє «збій залишків».
 */
describe('pickServicePartWarehouse — BR-WO-038', () => {
  const B1 = 'branch-1';
  const B2 = 'branch-2';
  const ORG_MAIN = 'wh-org-main'; // основний склад організації — у ІНШІЙ філії
  const B1_SHOP = 'wh-b1-shop';
  const B1_MAIN_TYPE = 'wh-b1-main-type';
  const B1_MOBILE = 'wh-b1-mobile';
  const B2_SIDE = 'wh-b2-side';
  const warehouses: PickableWarehouse[] = [
    { id: ORG_MAIN, isMain: true, branchId: B2, type: 'MAIN' },
    { id: B1_SHOP, branchId: B1, type: 'WORKSHOP' },
    { id: B1_MAIN_TYPE, branchId: B1, type: 'MAIN' },
    { id: B1_MOBILE, branchId: B1, type: 'MOBILE' },
    { id: B2_SIDE, branchId: B2, type: 'WORKSHOP' },
  ];

  // guards: BR-WO-038
  it('склад філії з найбільшою вільною кількістю, а не перший з вільною', () => {
    const got = pickServicePartWarehouse(
      free([
        [B1_SHOP, 1],
        [B1_MOBILE, 7],
        [B1_MAIN_TYPE, 3],
      ]),
      warehouses,
      B1,
    );
    expect(got).toBe(B1_MOBILE);
  });

  // guards: BR-WO-038
  it('найбільший залишок — на складі іншої філії: його не беремо, лише склади філії наряду', () => {
    const got = pickServicePartWarehouse(
      free([
        [ORG_MAIN, 50],
        [B2_SIDE, 40],
        [B1_SHOP, 2],
      ]),
      warehouses,
      B1,
    );
    expect(got).toBe(B1_SHOP);
  });

  // guards: BR-WO-038
  it('рівність вільної → основний склад', () => {
    const list: PickableWarehouse[] = [
      { id: B1_SHOP, branchId: B1 },
      { id: B1_MAIN_TYPE, branchId: B1, isMain: true },
    ];
    expect(
      pickServicePartWarehouse(
        free([
          [B1_SHOP, 4],
          [B1_MAIN_TYPE, 4],
        ]),
        list,
        B1,
      ),
    ).toBe(B1_MAIN_TYPE);
  });

  // guards: BR-WO-038
  it('вільної немає ніде у філії → основний склад філії', () => {
    const list: PickableWarehouse[] = [
      { id: B1_SHOP, branchId: B1, type: 'WORKSHOP' },
      { id: B1_MAIN_TYPE, branchId: B1, type: 'WORKSHOP', isMain: true },
    ];
    expect(pickServicePartWarehouse(free([[ORG_MAIN, 9]]), list, B1)).toBe(B1_MAIN_TYPE);
  });

  // guards: BR-WO-038
  it('основного у філії немає (він в іншій філії) → перший склад типу MAIN цієї філії', () => {
    expect(pickServicePartWarehouse(free([]), warehouses, B1)).toBe(B1_MAIN_TYPE);
  });

  // guards: BR-WO-038
  it('у філії ні основного, ні типу MAIN → перший склад філії', () => {
    const list: PickableWarehouse[] = [
      { id: B1_MOBILE, branchId: B1, type: 'MOBILE' },
      { id: B1_SHOP, branchId: B1, type: 'WORKSHOP' },
    ];
    expect(pickServicePartWarehouse(free([]), list, B1)).toBe(B1_MOBILE);
  });

  // guards: BR-WO-038
  it('збій запиту залишків (null) → основний / перший склад філії, не порожньо', () => {
    expect(pickServicePartWarehouse(null, warehouses, B1)).toBe(B1_MAIN_TYPE);
    expect(pickServicePartWarehouse(null, warehouses, B2)).toBe(ORG_MAIN);
  });

  // guards: BR-WO-038
  it('у філії складів немає → порожньо (обирає людина); філію не обрано → усі склади', () => {
    expect(pickServicePartWarehouse(free([[ORG_MAIN, 1]]), warehouses, 'branch-empty')).toBe('');
    expect(pickServicePartWarehouse(free([[B2_SIDE, 3]]), warehouses, '')).toBe(B2_SIDE);
  });
});
