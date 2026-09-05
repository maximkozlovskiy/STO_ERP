import { describe, it, expect } from 'vitest';
import { uniqueDefinedIds, initCountsMap } from './linked-counts';

describe('uniqueDefinedIds', () => {
  it('дедуплікує повтори, зберігаючи порядок першої появи', () => {
    expect(uniqueDefinedIds(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('відсіює null, undefined та порожній рядок', () => {
    expect(uniqueDefinedIds(['a', null, undefined, '', 'b'])).toEqual(['a', 'b']);
  });

  it('порожній вхід → []', () => {
    expect(uniqueDefinedIds([])).toEqual([]);
  });

  it('усі нульові → []', () => {
    expect(uniqueDefinedIds([null, undefined, ''])).toEqual([]);
  });

  it('non-nullable колонки (supplier-returns supplierId/warehouseId): null-фільтр не змінює результат', () => {
    // Усі значення присутні (NOT NULL у БД) — новий фільтр !!v не викидає нічого.
    const ids = ['sup1', 'sup2', 'sup1', 'wh1'];
    expect(uniqueDefinedIds(ids)).toEqual(['sup1', 'sup2', 'wh1']);
  });
});

describe('initCountsMap', () => {
  it('усі ключі занулені для кожного id', () => {
    const m = initCountsMap(['a', 'b'], ['foo', 'bar'] as const);
    expect(m).toEqual({
      a: { foo: 0, bar: 0 },
      b: { foo: 0, bar: 0 },
    });
  });

  it('порожній список id → {}', () => {
    expect(initCountsMap([], ['foo'] as const)).toEqual({});
  });

  it('порожній список ключів → пусті обʼєкти на кожен id', () => {
    expect(initCountsMap(['a'], [] as const)).toEqual({ a: {} });
  });

  // ДИСКРИМІНАТОР: кожен id мусить мати НЕЗАЛЕЖНИЙ обʼєкт лічильників.
  // Якби реалізація зробила `const zero = {...}; for (id) out[id] = zero`,
  // мутація result['a'].foo протекла б у result['b'].foo (aliasing).
  it('кожен id отримує НЕЗАЛЕЖНИЙ обʼєкт (немає aliasing)', () => {
    const m = initCountsMap(['a', 'b'], ['foo', 'bar'] as const);
    expect(m['a']).not.toBe(m['b']);
    m['a'].foo = 99;
    expect(m['b'].foo).toBe(0); // не протекло
    expect(m['a'].bar).toBe(0); // сусідній ключ у тому ж id не зачеплений
  });

  it('дублікати id → одна спільна колонка (останній перезапис), без aliasing між різними id', () => {
    const m = initCountsMap(['a', 'a', 'b'], ['foo'] as const);
    expect(Object.keys(m)).toEqual(['a', 'b']);
    m['a'].foo = 5;
    expect(m['b'].foo).toBe(0);
  });
});
