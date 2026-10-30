// Прев'ю суми рядка картки рахунку (BR-INV-017, BR-INV-024): змінений збережений рядок показує суму з
// ПДВ пропорційно новій сумі без ПДВ — ставка рядка та сама.
//
// Mutation-verify: повертати `lineTotalWithVat` завжди → падає «змінений рядок»; рахувати змінений
// рядок без ПДВ (`net`) → падає «ПДВ росте разом із сумою».

import { describe, it, expect } from 'vitest';
import { linePreviewTotal } from '../invoice-line-total';

const NET = new Map([['l-1', 100]]);

describe('linePreviewTotal', () => {
  it('новий рядок — кількість × ціна (без ПДВ, його додасть сервер)', () => {
    expect(linePreviewTotal({ quantity: '2', unitPrice: '15.5' }, NET)).toBe(31);
  });

  it('збережений незмінений — сума з ПДВ від сервера як є', () => {
    expect(
      linePreviewTotal({ id: 'l-1', quantity: '1', unitPrice: '100', lineTotalWithVat: 120 }, NET),
    ).toBe(120);
  });

  // guards: BR-INV-024
  it('змінений рядок — ПДВ росте разом із сумою (100 → 250 без ПДВ: 120 → 300)', () => {
    expect(
      linePreviewTotal(
        { id: 'l-1', quantity: '2.5', unitPrice: '100', lineTotalWithVat: 120 },
        NET,
      ),
    ).toBe(300);
  });

  it('серверна сума без ПДВ нуль — пропорції немає, кількість × ціна', () => {
    expect(
      linePreviewTotal(
        { id: 'l-0', quantity: '1', unitPrice: '40', lineTotalWithVat: 0 },
        new Map([['l-0', 0]]),
      ),
    ).toBe(40);
  });
});
