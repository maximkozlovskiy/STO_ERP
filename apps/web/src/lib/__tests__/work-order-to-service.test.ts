// «Зберегти як послугу» (BR-WO-036): рядки наряду → склад послуги. Послуга тримає роботу один раз, а
// `applyService` множить норму каталогу на кількість — тому кількість роботи = Σ годин ÷ норма.
//
// Мутації (перевірено): ділити не на норму, а лишити суму годин → падає «Σ годин ÷ норма»;
// прибрати групування за workId → падає «однакові роботи — один рядок»; не пропускати роботу поза
// каталогом → падає «видалена робота»; без коефіцієнта одиниці → падає «товар у базовій одиниці».
// Гілка «норма 0 → 1» еквівалентна: ділення на 0 дає Infinity, і `positiveQuantity` теж дає 1.

import { describe, it, expect } from 'vitest';
import { buildServiceFromWorkOrder } from '../work-order-to-service';

const W1 = 'work-1';
const W2 = 'work-2';
const G1 = 'good-1';
const G2 = 'good-2';

describe('buildServiceFromWorkOrder (BR-WO-036)', () => {
  // guards: BR-WO-036
  it('кількість роботи — Σ годин рядків ÷ норма каталогу, 2 знаки', () => {
    const r = buildServiceFromWorkOrder(
      [{ workId: W1, normoHours: 1.5 }],
      [],
      new Map([[W1, 0.5]]),
    );
    expect(r.works).toEqual([{ workId: W1, quantity: 3 }]);

    const third = buildServiceFromWorkOrder(
      [{ workId: W1, normoHours: 1 }],
      [],
      new Map([[W1, 3]]),
    );
    expect(third.works).toEqual([{ workId: W1, quantity: 0.33 }]);
  });

  // guards: BR-WO-036
  it('однакові роботи — один рядок послуги з сумою годин (ключ послуги — пара id)', () => {
    const r = buildServiceFromWorkOrder(
      [
        { workId: W1, normoHours: 1.5 },
        { workId: W2, normoHours: 2 },
        { workId: W1, normoHours: 2 },
      ],
      [],
      new Map([
        [W1, 1],
        [W2, 2],
      ]),
    );
    expect(r.works).toEqual([
      { workId: W1, quantity: 3.5 },
      { workId: W2, quantity: 1 },
    ]);
  });

  // guards: BR-WO-036
  it('норма каталогу 0 чи сума годин 0 → кількість 1 (сервер приймає від 0.01)', () => {
    const r = buildServiceFromWorkOrder(
      [
        { workId: W1, normoHours: 2 },
        { workId: W2, normoHours: 0 },
      ],
      [],
      new Map([
        [W1, 0],
        [W2, 1.5],
      ]),
    );
    expect(r.works).toEqual([
      { workId: W1, quantity: 1 },
      { workId: W2, quantity: 1 },
    ]);
  });

  // guards: BR-WO-036
  it('робота, якої немає в каталозі (видалена), не потрапляє в послугу і названа в skippedWorkIds', () => {
    const r = buildServiceFromWorkOrder(
      [
        { workId: W1, normoHours: 1 },
        { workId: 'gone', normoHours: 2 },
        { workId: 'gone', normoHours: 1 },
      ],
      [],
      new Map([[W1, 1]]),
    );
    expect(r.works).toEqual([{ workId: W1, quantity: 1 }]);
    expect(r.skippedWorkIds).toEqual(['gone']);
  });

  // guards: BR-WO-036
  it('товар, якого немає в каталозі (видалений), не потрапляє в послугу і названий у skippedGoodIds', () => {
    const r = buildServiceFromWorkOrder(
      [],
      [
        { goodId: G1, quantity: 2 },
        { goodId: 'gone', quantity: 1 },
        { goodId: 'gone', quantity: 3 },
      ],
      new Map(),
      new Set([G1]),
    );
    expect(r.goods).toEqual([{ goodId: G1, quantity: 2 }]);
    expect(r.skippedGoodIds).toEqual(['gone']);
  });

  // guards: BR-WO-036
  it('товари згруповано за goodId, кількість — сума в базовій одиниці (× коефіцієнт рядка)', () => {
    const r = buildServiceFromWorkOrder(
      [],
      [
        { goodId: G1, quantity: 2 },
        { goodId: G2, quantity: 1, coefficient: 4 },
        { goodId: G1, quantity: 1.5, coefficient: 1 },
      ],
      new Map(),
    );
    expect(r.goods).toEqual([
      { goodId: G1, quantity: 3.5 },
      { goodId: G2, quantity: 4 },
    ]);
    expect(r.works).toEqual([]);
  });

  it('дрібна кількість товару — 3 знаки; нульова → 1', () => {
    const r = buildServiceFromWorkOrder(
      [],
      [
        { goodId: G1, quantity: 0.12351 },
        { goodId: G2, quantity: 0 },
      ],
      new Map(),
    );
    expect(r.goods).toEqual([
      { goodId: G1, quantity: 0.124 },
      { goodId: G2, quantity: 1 },
    ]);
  });
});
