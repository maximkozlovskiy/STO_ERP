// Звіт «Виручка»: завжди три величини — сума без ПДВ, ПДВ, сума з ПДВ — у картках, у таблиці
// по днях і в CSV. Середній чек рахується від суми БЕЗ ПДВ.
//
// Mutation-verify (прогнано): (1) показати в колонці ПДВ суму з ПДВ → кейс «колонки» падає; (2) рахувати
// середній чек від totalRevenueWithVat → кейс «середній чек» падає; (3) прибрати vat із CSV →
// кейс «CSV» падає.
import { render, screen, within } from '@testing-library/react';
import { it, expect, describe } from 'vitest';
import type { TFunction } from 'i18next';
import type { ApiSchema } from '@sto/shared';
import i18n from 'i18next';
import { RevenueReport, buildRevenueCsv } from '../RevenueReport';

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s/g, ' ');

const data: ApiSchema<'RevenueReportDto'> = {
  rows: [
    {
      date: '2026-10-07',
      revenue: 1000,
      vat: 200,
      revenueWithVat: 1200,
      labor: 600,
      parts: 400,
      count: 2,
    },
    {
      date: '2026-10-08',
      revenue: 500,
      vat: 100,
      revenueWithVat: 600,
      labor: 500,
      parts: 0,
      count: 1,
    },
  ],
  totalRevenue: 1500,
  totalVat: 300,
  totalRevenueWithVat: 1800,
  totalOrders: 3,
  from: '2026-10-01',
  to: '2026-10-08',
};

const cardValue = (label: string) =>
  norm(screen.getAllByText(label).find(el => el.tagName !== 'TH')?.parentElement?.textContent);

describe('RevenueReport — сума, ПДВ, сума з ПДВ', () => {
  it('картки-підсумки показують три величини окремо', () => {
    render(<RevenueReport data={data} />);

    expect(cardValue('Сума (без ПДВ)')).toContain('1 500,00 ₴');
    expect(cardValue('Сума з ПДВ')).toContain('1 800,00 ₴');
    // «ПДВ» є і карткою, і заголовком колонки — картка та, що несе суму.
    expect(cardValue('ПДВ')).toContain('300,00 ₴');
  });

  it('середній чек рахується від суми без ПДВ і так підписаний', () => {
    render(<RevenueReport data={data} />);
    // 1500 / 3 = 500, а не 1800 / 3 = 600
    expect(cardValue('Середній чек (без ПДВ)')).toContain('500,00 ₴');
    expect(cardValue('Середній чек (без ПДВ)')).not.toContain('600,00');
  });

  it('таблиця по днях має колонки «Сума», «ПДВ», «Сума з ПДВ», числові — праворуч', () => {
    render(<RevenueReport data={data} />);
    const table = screen.getByRole('table');
    const heads = within(table).getAllByRole('columnheader');

    expect(heads.map(h => h.textContent)).toEqual([
      'Дата',
      'Нарядів',
      'Роботи',
      'Запчастини',
      'Сума',
      'ПДВ',
      'Сума з ПДВ',
    ]);
    for (const h of heads.slice(1)) expect(h.className).toContain('text-right');

    const firstRow = within(table).getAllByRole('row')[1];
    const cells = within(firstRow).getAllByRole('cell');
    expect(cells.map(c => norm(c.textContent))).toEqual([
      '07.10.2026',
      '2',
      '600,00 ₴',
      '400,00 ₴',
      '1 000,00 ₴',
      '200,00 ₴',
      '1 200,00 ₴',
    ]);
    for (const c of cells.slice(1)) {
      expect(c.className).toContain('text-right');
      expect(c.className).toContain('tabular-nums');
    }
  });

  it('рядок «Разом» несе підсумки періоду', () => {
    render(<RevenueReport data={data} />);
    const total = norm(screen.getByTestId('revenue-total-row').textContent);
    expect(total).toContain('Разом');
    expect(total).toContain('1 500,00 ₴');
    expect(total).toContain('300,00 ₴');
    expect(total).toContain('1 800,00 ₴');
  });

  it('без нарядів за період: порожній стан замість таблиці нулів, середній чек «—»', () => {
    render(
      <RevenueReport
        data={{
          ...data,
          rows: [],
          totalRevenue: 0,
          totalVat: 0,
          totalRevenueWithVat: 0,
          totalOrders: 0,
        }}
      />,
    );
    expect(screen.getByText('За період немає завершених нарядів')).toBeTruthy();
    expect(screen.queryByTestId('revenue-total-row')).toBeNull();
    expect(cardValue('Середній чек (без ПДВ)')).toContain('—');
  });

  it('організація без ПДВ: колонки ті самі, ПДВ нульовий, суми збігаються', () => {
    render(
      <RevenueReport
        data={{
          ...data,
          rows: [{ ...data.rows[0], vat: 0, revenueWithVat: 1000 }],
          totalRevenue: 1000,
          totalVat: 0,
          totalRevenueWithVat: 1000,
          totalOrders: 2,
        }}
      />,
    );
    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell');
    expect(norm(cells[4].textContent)).toBe('1 000,00 ₴');
    expect(norm(cells[5].textContent)).toBe('0,00 ₴');
    expect(norm(cells[6].textContent)).toBe('1 000,00 ₴');
  });
});

describe('buildRevenueCsv', () => {
  it('CSV несе суму, ПДВ і суму з ПДВ окремими колонками', () => {
    const t = i18n.getFixedT('uk', 'reports') as unknown as TFunction<'reports'>;
    const lines = buildRevenueCsv(data, t).split('\n');

    expect(lines[0]).toBe('Дата;Нарядів;Роботи;Запчастини;Сума;ПДВ;Сума з ПДВ');
    expect(lines[1]).toBe('2026-10-07;2;600;400;1000;200;1200');
    expect(lines[2]).toBe('2026-10-08;1;500;0;500;100;600');
    expect(lines).toHaveLength(3);
  });
});
