// WorkOrderTotals — блок підсумків картки наряду (BR-WO-007).
// Коли ПДВ у сумі є — три рядки «Сума без ПДВ / ПДВ / Разом»; коли немає — один «Разом».
// ПДВ береться як totalAmount − totalNet, а не з поля totalVat.
//
// Mutation-verify (прогнано): (1) `hasVat = false` у VatTotalsSummary → кейси «три рядки»
// падають; (2) `hasVat = true` → кейс «без ПДВ: один підсумок» падає; (3) порівнювати оплату
// з сумою без ПДВ → кейс «оплачено рівно без ПДВ» падає.
import { render, screen } from '@testing-library/react';
import { it, expect, describe } from 'vitest';
import { WorkOrderTotals } from '../WorkOrderTotals';

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s/g, ' ');
const rowText = (testId: string) => norm(screen.getByTestId(testId).textContent);

const base = {
  totalLabor: 1000,
  totalActualLabor: 1000,
  totalParts: 200,
  paidAmount: 0,
  sym: '₴',
};

// guards: BR-WO-007
describe('WorkOrderTotals — розкладка ПДВ у картці наряду', () => {
  it('«ПДВ зверху»: три рядки, разом = без ПДВ + ПДВ, а не «роботи + запчастини»', () => {
    render(<WorkOrderTotals {...base} totalNet={1200} totalAmount={1440} />);

    expect(rowText('vat-totals-net')).toBe('Сума без ПДВ1 200,00 ₴');
    expect(rowText('vat-totals-vat')).toBe('ПДВ240,00 ₴');
    expect(rowText('vat-totals-gross')).toBe('Разом1 440,00 ₴');
  });

  it('«ПДВ у ціні»: разом = сума рядків, без ПДВ менше на ПДВ', () => {
    render(<WorkOrderTotals {...base} totalNet={1000} totalAmount={1200} />);

    expect(rowText('vat-totals-net')).toBe('Сума без ПДВ1 000,00 ₴');
    expect(rowText('vat-totals-vat')).toBe('ПДВ200,00 ₴');
    expect(rowText('vat-totals-gross')).toBe('Разом1 200,00 ₴');
  });

  it('без ПДВ: один підсумок «Разом», рядків «Сума без ПДВ» і «ПДВ» немає', () => {
    render(<WorkOrderTotals {...base} totalNet={1200} totalAmount={1200} />);

    expect(rowText('vat-totals-gross')).toBe('Разом1 200,00 ₴');
    expect(screen.queryByTestId('vat-totals-net')).toBeNull();
    expect(screen.queryByTestId('vat-totals-vat')).toBeNull();
    expect(screen.queryByText('ПДВ')).toBeNull();
  });

  it('наряд до 2026-10-08 (totalNet = totalAmount): ПДВ не показано, хоч totalVat у БД ненульовий', () => {
    // totalVat навмисно не передається в компонент узагалі — джерело ПДВ лише різниця сум.
    render(<WorkOrderTotals {...base} totalNet={1200} totalAmount={1200} />);
    expect(screen.queryByTestId('vat-totals-vat')).toBeNull();
  });

  it('відповідь без totalNet (старий кеш) не ламає блок: один підсумок', () => {
    render(<WorkOrderTotals {...base} totalAmount={1200} />);
    expect(rowText('vat-totals-gross')).toBe('Разом1 200,00 ₴');
    expect(screen.queryByTestId('vat-totals-net')).toBeNull();
  });

  it('оплачено порівнюється з сумою ДО СПЛАТИ: оплата рівно «без ПДВ» ще не повна', () => {
    const { rerender } = render(
      <WorkOrderTotals {...base} totalNet={1200} totalAmount={1440} paidAmount={1200} />,
    );
    expect(screen.getByTestId('wo-totals-paid').className).not.toContain('text-success');

    rerender(<WorkOrderTotals {...base} totalNet={1200} totalAmount={1440} paidAmount={1440} />);
    expect(screen.getByTestId('wo-totals-paid').className).toContain('text-success');
  });

  it('факт відрізняється від плану → показано обидві суми робіт', () => {
    render(
      <WorkOrderTotals
        {...base}
        totalLabor={1000}
        totalActualLabor={1500}
        totalNet={1700}
        totalAmount={2040}
      />,
    );
    expect(screen.getByText('Роботи (план)')).toBeTruthy();
    expect(norm(document.body.textContent)).toContain('1 500,00 ₴');
  });
});
