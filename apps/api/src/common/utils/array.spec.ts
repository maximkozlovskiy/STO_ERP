import { describe, it, expect } from 'vitest';
import { deduplicateBy } from './array';

// Bug #487: regression-guard для нового utility — інші файли common/utils/
// (fsm/math/pagination/url-guard) мають парні spec. Без unit-тесту майбутній refactor
// `deduplicateBy` може силенто змінити last-write-wins на first-write-wins → applyPricing
// у purchase-orders.service + xlsx.service отримає race-deterministic salePrice коли
// production-дані мають дублікати по goodId.
describe('deduplicateBy', () => {
  it('повертає порожній масив для порожнього входу', () => {
    expect(deduplicateBy([], (x: { id: string }) => x.id)).toEqual([]);
  });

  it('повертає одинокий елемент без модифікації', () => {
    const item = { id: '1', val: 'a' };
    expect(deduplicateBy([item], x => x.id)).toEqual([item]);
  });

  it('зберігає ОСТАННЄ входження для дублікатів (last-wins) — критичний інваріант applyPricing', () => {
    // Цей тест документує key invariant: PO може мати кілька рядків з тим же goodId
    // (різні lot-ціни). Sequential for-loop мав last-wins семантику. Promise.all без dedup
    // дав би нондетерміністичну гонитьбу. dedupedPlan зберігає last-wins → race-safe.
    const items = [
      { goodId: 'g1', newSalePrice: 100 },
      { goodId: 'g2', newSalePrice: 200 },
      { goodId: 'g1', newSalePrice: 150 }, // останній для g1 → перемагає
    ];
    const result = deduplicateBy(items, u => u.goodId);
    expect(result).toHaveLength(2);
    expect(result.find(r => r.goodId === 'g1')?.newSalePrice).toBe(150);
    expect(result.find(r => r.goodId === 'g2')?.newSalePrice).toBe(200);
  });

  it('всі унікальні ключі — повертає все без змін (зберігає порядок Map insertion)', () => {
    const items = [
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
      { id: 'c', v: 3 },
    ];
    expect(deduplicateBy(items, x => x.id)).toEqual(items);
  });

  it('всі дублікати одного ключа → один елемент (останній)', () => {
    const items = [
      { id: 'x', v: 1 },
      { id: 'x', v: 2 },
      { id: 'x', v: 3 },
    ];
    expect(deduplicateBy(items, x => x.id)).toEqual([{ id: 'x', v: 3 }]);
  });

  it('підтримує numeric ключі (Map зберігає insertion order — k=1 на першому місці)', () => {
    // Map.set(key) на існуючий key оновлює value але НЕ змінює position у insertion order.
    // Тому k=1 (вставлений першим) лишається на index 0, value оновлено на 'c'.
    const items = [
      { k: 1, v: 'a' },
      { k: 2, v: 'b' },
      { k: 1, v: 'c' },
    ];
    expect(deduplicateBy(items, x => x.k)).toEqual([
      { k: 1, v: 'c' },
      { k: 2, v: 'b' },
    ]);
  });

  it('підтримує null/undefined як ключ — group all', () => {
    // Сценарій guard: якщо key fn повертає null/undefined для всіх — згрупуються в один bucket
    const items = [
      { id: null, v: 1 },
      { id: null, v: 2 },
    ];
    expect(deduplicateBy(items, x => x.id)).toEqual([{ id: null, v: 2 }]);
  });

  it('пара null + undefined — рахуються як РІЗНІ ключі (Map !==)', () => {
    // Map розрізняє null !== undefined → це окремі buckets
    const items = [
      { id: null as unknown as string | null | undefined, v: 1 },
      { id: undefined as unknown as string | null | undefined, v: 2 },
    ];
    expect(deduplicateBy(items, x => x.id)).toHaveLength(2);
  });

  it('immutability — оригінальний масив не модифікується', () => {
    const items = [
      { id: 'a', v: 1 },
      { id: 'a', v: 2 },
    ];
    const before = JSON.stringify(items);
    deduplicateBy(items, x => x.id);
    expect(JSON.stringify(items)).toBe(before);
  });
});
