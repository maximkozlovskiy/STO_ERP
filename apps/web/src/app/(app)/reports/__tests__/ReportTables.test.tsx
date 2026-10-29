// Таблиці звітів (огляд звітів 2026-10-29): «Завантаженість» читабельна — підйомники із записами
// за відсотком (більші зверху), підпис відсотка з комою, без записів — одним рядком «Ще N…»;
// переходи з рядків — механік → його наряди за період звіту, контрагент → картка контрагента,
// товар складу → картка товару (лише коли роль має до неї доступ).
//
// Mutation-verify (2026-10-29): прибрати сортування в splitLoadRows → падає «за відсотком»; не
// відкидати totalSlots = 0 → падає «ще N без записів»; `toFixed(1)%` замість fmtPercent → падає
// «відсоток з комою»; не передавати from/to у посилання → падає «наряди механіка».
import { render, screen, fireEvent, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { ApiSchema } from '@sto/shared';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/reports',
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));

import {
  LoadReportView,
  SettlementsReportView,
  StockReportView,
  WorkOrdersReportView,
  splitLoadRows,
} from '../ReportTables';
import { axisDayLabel } from '../ReportsCharts';

type LoadRow = ApiSchema<'LoadReportDto'>['rows'][number];
const lift = (liftName: string, loadPercent: number, totalSlots = 3): LoadRow => ({
  liftId: `id-${liftName}`,
  liftName,
  zoneName: 'Зона А',
  totalSlots,
  totalHours: 6,
  loadPercent,
});
const PERIOD = { from: '2026-10-01', to: '2026-10-31', totalDays: 31 };
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s/g, ' ');

beforeEach(() => push.mockReset());

describe('«Завантаженість» — читабельність', () => {
  it('splitLoadRows: із записами — за відсотком спадно; без записів — лише лічильник', () => {
    const { busy, idle } = splitLoadRows([
      lift('П-1', 12),
      lift('П-2', 0, 0),
      lift('П-3', 64),
      lift('П-4', 0, 0),
      lift('П-5', 30),
    ]);
    expect(busy.map(r => r.liftName)).toEqual(['П-3', 'П-5', 'П-1']);
    expect(idle).toBe(2);
  });

  it('таблиця: більші зверху, відсоток з комою, підйомники без записів — рядком «Ще N…»', () => {
    render(
      <LoadReportView
        data={{
          ...PERIOD,
          rows: [lift('П-1', 12.5), lift('П-2', 0, 0), lift('П-3', 64), lift('П-4', 0, 0)],
        }}
      />,
    );
    const rows = screen.getAllByTestId('report-load-row');
    expect(rows.map(r => within(r).getAllByRole('cell')[0]?.textContent)).toEqual(['П-3', 'П-1']);
    expect(norm(rows[1]?.textContent)).toContain('12,5%');
    expect(screen.getByTestId('report-load-idle')).toHaveTextContent(
      'Ще 2 підйомники без записів за період',
    );
    expect(screen.queryByText('П-2')).toBeNull();
  });

  it('без жодного запису — лише рядок «Ще N…»', () => {
    render(<LoadReportView data={{ ...PERIOD, rows: [lift('П-2', 0, 0)] }} />);
    expect(screen.queryAllByTestId('report-load-row')).toHaveLength(0);
    expect(screen.getByTestId('report-load-idle')).toHaveTextContent(
      'Ще 1 підйомник без записів за період',
    );
  });
});

describe('переходи з рядків звітів', () => {
  it('«Наряди»: механік → його наряди з фільтром виконавця й періодом звіту (клік і клавіатура)', () => {
    render(
      <WorkOrdersReportView
        data={{
          rows: [
            {
              employeeId: '11111111-1111-4111-8111-111111111111',
              employeeName: 'Петренко Іван',
              totalNormoHours: 3,
              totalAmount: 1500,
              linesCount: 2,
            },
          ],
          totalNormoHours: 3,
          totalAmount: 1500,
          from: '2026-10-01',
          to: '2026-10-29',
        }}
        from="2026-10-01"
        to="2026-10-29"
      />,
    );
    const row = screen.getByTestId('report-wo-row');
    fireEvent.click(row);
    const url = new URL(String(push.mock.calls[0]?.[0]), 'http://x');
    expect(url.pathname).toBe('/work-orders');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      employeeId: '11111111-1111-4111-8111-111111111111',
      employeeName: 'Петренко Іван',
      dateFrom: '2026-10-01',
      dateTo: '2026-10-29',
    });
    // Кнопка-назва для клавіатури: її клік спливає до рядка — перехід один, не два.
    push.mockReset();
    fireEvent.click(within(row).getByRole('button', { name: 'Петренко Іван' }));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('«Взаєморозрахунки»: контрагент → його картка; нульовий баланс не показується', () => {
    render(
      <SettlementsReportView
        data={{
          rows: [
            { counterpartyId: 'cp-1', counterpartyName: 'ТОВ Альфа', type: 'CLIENT', balance: 250 },
            { counterpartyId: 'cp-0', counterpartyName: 'ТОВ Нуль', type: 'CLIENT', balance: 0 },
          ],
          totalDebit: 250,
          totalCredit: 0,
        }}
      />,
    );
    expect(screen.queryByText('ТОВ Нуль')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ТОВ Альфа' }));
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/counterparties/cp-1');
  });

  it('«Звіт по складу»: товар → картка товару; без доступу — рядок не клікабельний', () => {
    const data = {
      stockItems: [
        {
          goodId: 'g-1',
          goodName: 'Фільтр масляний',
          goodSku: 'OF-1',
          unit: 'шт',
          warehouseName: 'Основний',
          quantity: 4,
          reserved: 1,
          available: 3,
          value: 400,
        },
      ],
      movements: [],
      totalValue: 400,
    };
    const onOpenGood = vi.fn();
    const { unmount } = render(<StockReportView data={data} onOpenGood={onOpenGood} />);
    fireEvent.click(screen.getByRole('button', { name: 'Фільтр масляний' }));
    expect(onOpenGood).toHaveBeenCalledTimes(1);
    expect(onOpenGood).toHaveBeenCalledWith('g-1');
    unmount();

    render(<StockReportView data={data} />);
    expect(screen.queryByRole('button', { name: 'Фільтр масляний' })).toBeNull();
    expect(screen.getByText('Фільтр масляний')).toBeInTheDocument();
  });
});

describe('графік виручки — вісь днів', () => {
  it('«ДД.ММ» замість ISO-дати; не дата — як є', () => {
    expect(axisDayLabel('2026-06-11')).toBe('11.06');
    expect(axisDayLabel('2026-12-01')).toBe('01.12');
    expect(axisDayLabel('—')).toBe('—');
  });
});
