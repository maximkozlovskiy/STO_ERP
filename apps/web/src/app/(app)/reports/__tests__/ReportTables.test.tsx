// Таблиці звітів (огляд звітів 2026-10-29): «Завантаженість» читабельна — підйомники із записами
// за відсотком (більші зверху), підпис відсотка з комою, без записів — одним рядком «Ще N…»;
// переходи з рядків — механік → його наряди за період звіту, контрагент → картка контрагента,
// товар складу → картка товару (лише коли роль має до неї доступ).
//
// Mutation-verify (2026-10-29): прибрати сортування в splitLoadRows → падає «за відсотком»; не
// відкидати totalSlots = 0 → падає «ще N без записів»; `toFixed(1)%` замість fmtPercent → падає
// «відсоток з комою»; не передавати from/to у посилання → падає «наряди механіка».
// BR-RPT-031/033/034 (2026-10-29): без `status` у посиланні механіка → падає «наряди механіка»;
// годин без місткості → падає «N год з M»; одна колонка вартості → падає «дві вартості».
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
  capacityHours: 45,
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
    // guards: BR-RPT-033 — зайнято з робочого часу філії за період.
    expect(norm(rows[1]?.textContent)).toContain('6 год з 45');
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
    // guards: BR-RPT-031 — той самий відбір статусів, що звіт: усі, крім скасованих.
    expect(Object.fromEntries(url.searchParams)).toEqual({
      employeeId: '11111111-1111-4111-8111-111111111111',
      employeeName: 'Петренко Іван',
      dateFrom: '2026-10-01',
      dateTo: '2026-10-29',
      status: 'DRAFT,ESTIMATE,APPROVED,IN_PROGRESS,ON_HOLD,COMPLETED,INVOICED,PAID,ARCHIVED',
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
          goodDeleted: false,
          unit: 'шт',
          warehouseName: 'Основний',
          quantity: 4,
          reserved: 1,
          available: 3,
          costValue: 240,
          saleValue: 400,
        },
      ],
      movements: [],
      totalCostValue: 240,
      totalSaleValue: 400,
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

  // guards: BR-RPT-032
  it('«Звіт по складу»: видалений товар — у таблиці й підсумку, з позначкою «видалено», без переходу', () => {
    const item = {
      goodSku: null,
      unit: 'шт',
      warehouseName: 'Основний',
      quantity: 3,
      reserved: 0,
      available: 3,
      costValue: 120,
      saleValue: 200,
    };
    const data = {
      stockItems: [
        { ...item, goodId: 'g-live', goodName: 'Свічка', goodDeleted: false },
        { ...item, goodId: 'g-gone', goodName: 'Старий фільтр', goodDeleted: true },
      ],
      movements: [],
      totalCostValue: 240,
      totalSaleValue: 400,
    };
    const onOpenGood = vi.fn();
    render(<StockReportView data={data} onOpenGood={onOpenGood} />);
    const rows = screen.getAllByTestId('report-stock-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('2')).toBeInTheDocument(); // позицій — обидві
    expect(screen.getByText('400,00 ₴')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Свічка' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Старий фільтр/ })).toBeNull();
    expect(screen.getByTestId('report-stock-deleted')).toHaveTextContent('видалено');
    fireEvent.click(rows[1]!);
    expect(onOpenGood).not.toHaveBeenCalled();
  });

  // guards: BR-RPT-034
  it('«Звіт по складу»: дві вартості — собівартість і ціни продажу — у рядку й підсумку', () => {
    render(
      <StockReportView
        data={{
          stockItems: [
            {
              goodId: 'g-1',
              goodName: 'Фільтр',
              goodSku: null,
              goodDeleted: false,
              unit: 'шт',
              warehouseName: 'Основний',
              quantity: 2,
              reserved: 0,
              available: 2,
              costValue: 150,
              saleValue: 260,
            },
          ],
          movements: [],
          totalCostValue: 150,
          totalSaleValue: 260,
        }}
      />,
    );
    expect(screen.getByRole('columnheader', { name: 'Собівартість' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'За цінами продажу' })).toBeInTheDocument();
    expect(norm(screen.getByTestId('report-stock-cost').textContent)).toBe('150,00 ₴');
    expect(norm(screen.getByTestId('report-stock-sale').textContent)).toBe('260,00 ₴');
    expect(screen.getByText('Собівартість залишків')).toBeInTheDocument();
    expect(screen.getByText('Залишки за цінами продажу')).toBeInTheDocument();
  });
});

describe('графік виручки — вісь днів', () => {
  it('«ДД.ММ» замість ISO-дати; не дата — як є', () => {
    expect(axisDayLabel('2026-06-11')).toBe('11.06');
    expect(axisDayLabel('2026-12-01')).toBe('01.12');
    expect(axisDayLabel('—')).toBe('—');
  });
});
