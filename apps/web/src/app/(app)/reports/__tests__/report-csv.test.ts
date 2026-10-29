// CSV фіксованих звітів: числа йдуть ЧИСЛАМИ, тож escapeCsvCell пише їх з десятковою комою — як
// інші числа файла (BR-RPT-021). Рядок `toFixed(1)` лишав крапку поруч із комою, а Excel з
// українськими налаштуваннями читав «1.5» датою; сума нормо-годин приходила з хвостом дробу
// (478.28000000000014).
//
// Mutation-verify (прогнано): повернути `r.totalHours.toFixed(1)` → кейс «Завантаженість» падає;
// прибрати round2 у нормо-годинах → кейс «Наряди» падає.
import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import i18n from 'i18next';
import { buildCsv, type ReportData } from '../report-csv';

const t = i18n.getFixedT('uk', 'reports') as unknown as TFunction<'reports'>;
const lines = (csv: string) => csv.split('\n').slice(1);

describe('report-csv › buildCsv', () => {
  // guards: BR-RPT-021
  it('«Наряди»: нормо-години без хвоста двійкового дробу, з комою', () => {
    const data = {
      _tab: 'work-orders',
      rows: [
        {
          employeeId: 'e1',
          employeeName: 'Петро',
          totalNormoHours: 478.28000000000014,
          totalAmount: 1250.5,
          linesCount: 3,
        },
      ],
      totalNormoHours: 478.28000000000014,
      totalAmount: 1250.5,
      from: '2026-10-01',
      to: '2026-10-25',
    } as ReportData;
    expect(lines(buildCsv('work-orders', data, t))).toEqual(['Петро;478,28;3;1250,5']);
  });

  // guards: BR-RPT-021
  it('«Завантаженість»: години з одним знаком після коми — числом, не рядком з крапкою', () => {
    const data = {
      _tab: 'load',
      rows: [
        {
          liftId: 'l1',
          liftName: 'Підйомник 1',
          zoneName: 'Зона А',
          totalSlots: 4,
          totalHours: 12.46,
          loadPercent: 62.5,
        },
      ],
      from: '2026-10-01',
      to: '2026-10-25',
      totalDays: 25,
    } as ReportData;
    expect(lines(buildCsv('load', data, t))).toEqual(['Підйомник 1;Зона А;4;12,5;62,5']);
  });

  // guards: BR-RPT-021
  it('«Рентабельність»: «% від виручки» — числа з комою, як і сума поруч', () => {
    const data = {
      _tab: 'profitability',
      totalRevenue: 1000,
      totalVat: 200,
      totalRevenueWithVat: 1200,
      totalCost: 407,
      totalCostParts: 307,
      totalCostLabor: 100,
      grossProfit: 593,
      margin: 59.3,
      ordersCount: 2,
      unknownCostPartsCount: 0,
      from: '2026-10-01',
      to: '2026-10-25',
    } as ReportData;
    const rows = lines(buildCsv('profitability', data, t));
    expect(rows[0]).toMatch(/;1000;100$/);
    expect(rows[1]).toMatch(/;307;30,7$/);
    expect(rows[2]).toMatch(/;100;10$/);
    expect(rows[3]).toMatch(/;593;59,3$/);
  });

  // guards: BR-RPT-021
  it("«ПДВ»: файл не порожній — нараховано, сплачено, до сплати; від'ємне — числом (Bug #977)", () => {
    const data = {
      _tab: 'vat',
      invoiced: 1250.5,
      purchases: 1400,
      net: -149.5,
      from: '2026-10-01',
      to: '2026-10-25',
    } as ReportData;
    const csv = buildCsv('vat', data, t);
    expect(csv.split('\n')).toHaveLength(4);
    expect(lines(csv)).toEqual([
      `${t('page.vat.invoiced')};1250,5`,
      `${t('page.vat.purchases')};1400`,
      `${t('page.vat.net')};-149,5`,
    ]);
  });

  // guards: BR-RPT-030
  it("«P&L»: рядки × місяці + «Разом», статті з відступом, від'ємне — числом з комою", () => {
    const data = {
      _tab: 'pnl',
      settings: {
        incomeCashReasons: ['MANUAL_IN'],
        expenseCashReasons: ['EXPENSE'],
        warnFuturePayroll: false,
        netAdvanceReturns: true,
      },
      months: ['2026-09', '2026-10'],
      rows: [
        { key: 'revenue', amounts: [1000, 2000.5], total: 3000.5 },
        { key: 'expenses', amounts: [100, 0], total: 100 },
        {
          key: 'expenseCategory',
          categoryId: 'c1',
          parentId: null,
          label: 'Оренда',
          depth: 0,
          amounts: [100, 0],
          total: 100,
        },
        {
          key: 'expenseCategory',
          categoryId: null,
          parentId: null,
          label: null,
          depth: 0,
          amounts: [0, 0],
          total: 0,
        },
        { key: 'netProfit', amounts: [-50.25, 2000.5], total: 1950.25 },
      ],
      unknownCostPartsCount: 0,
      payrollMissingMonths: [],
      from: '2026-09-01',
      to: '2026-10-31',
    } as ReportData;
    const csv = buildCsv('pnl', data, t);
    expect(csv.split('\n')[0]).toBe(
      `${t('page.pnl.colIndicator')};09.2026;10.2026;${t('page.pnl.colTotal')}`,
    );
    expect(lines(csv)).toEqual([
      `${t('page.pnl.rows.revenue')};1000;2000,5;3000,5`,
      `${t('page.pnl.rows.expenses')};100;0;100`,
      '· Оренда;100;0;100',
      `· ${t('page.pnl.noCategory')};0;0;0`,
      `${t('page.pnl.rows.netProfit')};-50,25;2000,5;1950,25`,
    ]);
  });

  // guards: BR-RPT-021
  it('кожна вкладка з даними дає непорожній CSV', () => {
    // Вкладка без гілки в buildCsv мовчки віддавала '' — порожній файл замість помилки.
    const tabs = [
      'revenue',
      'work-orders',
      'stock',
      'settlements',
      'load',
      'profitability',
      'pnl',
      'vat',
    ];
    const minimal: Record<string, ReportData> = {
      revenue: { _tab: 'revenue', rows: [], from: '', to: '' } as unknown as ReportData,
      'work-orders': { _tab: 'work-orders', rows: [] } as unknown as ReportData,
      stock: { _tab: 'stock', stockItems: [] } as unknown as ReportData,
      settlements: { _tab: 'settlements', rows: [] } as unknown as ReportData,
      load: { _tab: 'load', rows: [] } as unknown as ReportData,
      profitability: { _tab: 'profitability', totalRevenue: 0 } as unknown as ReportData,
      vat: { _tab: 'vat', invoiced: 0, purchases: 0, net: 0 } as unknown as ReportData,
      pnl: { _tab: 'pnl', months: [], rows: [] } as unknown as ReportData,
    };
    for (const tab of tabs) expect(buildCsv(tab, minimal[tab], t), tab).not.toBe('');
  });
});
