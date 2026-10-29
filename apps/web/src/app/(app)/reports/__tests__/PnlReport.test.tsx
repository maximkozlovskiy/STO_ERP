// Вкладка «P&L» (BR-RPT-030): рядки звіту × місяці + «Разом», чистий прибуток — підсумок таблиці,
// статті — з відступом за рівнем, від'ємні суми — червоним, попередження про місяці без зарплати й
// запчастини без закупівельної ціни.
//
// Mutation-verify (2026-10-29): прибрати `value < 0 && 'text-destructive'` → кейс «від'ємне червоним»
// падає; прибрати блок попередження про зарплату → кейс «попередження» падає; показувати `label`
// без запасного «Без статті» → кейс «рядки статей» падає.
import { render, screen, within } from '@testing-library/react';
import { it, expect, describe } from 'vitest';
import type { ApiSchema } from '@sto/shared';
import { PnlReport } from '../PnlReport';

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s/g, ' ');

const base: ApiSchema<'PnlReportDto'> = {
  months: ['2026-09', '2026-10'],
  rows: [
    { key: 'revenue', amounts: [10_000, 5000], total: 15_000 },
    { key: 'partsCost', amounts: [3000, 1000], total: 4000 },
    { key: 'grossProfit', amounts: [7000, 4000], total: 11_000 },
    { key: 'payroll', amounts: [2000, 6000], total: 8000 },
    { key: 'expenses', amounts: [500, 300], total: 800 },
    {
      key: 'expenseCategory',
      categoryId: 'util',
      parentId: null,
      label: 'Комунальні',
      depth: 0,
      amounts: [500, 300],
      total: 800,
    },
    {
      key: 'expenseCategory',
      categoryId: 'power',
      parentId: 'util',
      label: 'Електрика',
      depth: 1,
      amounts: [500, 300],
      total: 800,
    },
    { key: 'otherIncome', amounts: [0, 0], total: 0 },
    { key: 'fx', amounts: [0, 0], total: 0 },
    { key: 'netProfit', amounts: [4500, -2300], total: 2200 },
  ],
  unknownCostPartsCount: 0,
  payrollMissingMonths: [],
  settings: {
    incomeCashReasons: ['MANUAL_IN'],
    expenseCashReasons: ['EXPENSE'],
    warnFuturePayroll: false,
    netAdvanceReturns: true,
  },
  from: '2026-09-01',
  to: '2026-10-31',
};

describe('PnlReport — BR-RPT-030', () => {
  // guards: BR-RPT-030
  it('колонки — місяці й «Разом»; рядки звіту в порядку; чистий прибуток — у підсумку таблиці', () => {
    render(<PnlReport data={base} />);
    const headers = screen.getAllByRole('columnheader').map(h => h.textContent);
    expect(headers).toEqual(['Показник', '09.2026', '10.2026', 'Разом']);
    const revenue = screen.getByTestId('pnl-row-revenue');
    expect(norm(revenue.textContent)).toContain('Виручка (без ПДВ)');
    expect(norm(revenue.textContent)).toContain('10 000,00 ₴');
    expect(norm(revenue.textContent)).toContain('15 000,00 ₴');
    const net = screen.getByTestId('pnl-row-netProfit');
    expect(net.closest('tfoot')).not.toBeNull();
    expect(norm(net.textContent)).toContain('Чистий прибуток');
    expect(norm(net.textContent)).toContain('2 200,00 ₴');
  });

  // guards: BR-RPT-030
  it("від'ємне — червоним, додатне — ні", () => {
    render(<PnlReport data={base} />);
    const cells = within(screen.getByTestId('pnl-row-netProfit')).getAllByRole('cell');
    const minus = cells.find(c => norm(c.textContent).includes('2 300,00'));
    const plus = cells.find(c => norm(c.textContent).includes('4 500,00'));
    expect(minus?.className).toContain('text-destructive');
    expect(plus?.className).not.toContain('text-destructive');
  });

  // guards: BR-RPT-030
  it('рядки статей — з відступом за рівнем; стаття без назви й без статті мають підписи', () => {
    const data: ApiSchema<'PnlReportDto'> = {
      ...base,
      rows: [
        ...base.rows.slice(0, 7),
        {
          key: 'expenseCategory',
          categoryId: null,
          parentId: null,
          label: null,
          depth: 0,
          amounts: [1, 0],
          total: 1,
        },
        ...base.rows.slice(7),
      ],
    };
    render(<PnlReport data={data} />);
    const cats = screen.getAllByTestId('pnl-row-expenseCategory');
    expect(cats.map(r => r.firstElementChild?.textContent)).toEqual([
      'Комунальні',
      'Електрика',
      'Без статті',
    ]);
    expect(cats[0]?.firstElementChild?.className).toContain('pl-8');
    expect(cats[1]?.firstElementChild?.className).toContain('pl-12');
  });

  // guards: BR-RPT-030
  it('попередження: місяці без зарплати і запчастини без закупівельної ціни', () => {
    const { rerender } = render(<PnlReport data={base} />);
    expect(screen.queryByTestId('pnl-warnings')).not.toBeInTheDocument();
    rerender(
      <PnlReport data={{ ...base, payrollMissingMonths: ['2026-10'], unknownCostPartsCount: 3 }} />,
    );
    const warn = norm(screen.getByTestId('pnl-warnings').textContent);
    expect(warn).toContain('Зарплату не розраховано: 10.2026');
    expect(warn).toContain('У 3 запчастин невідома закупівельна ціна');
  });
});
