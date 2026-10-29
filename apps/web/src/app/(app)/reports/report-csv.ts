// CSV фіксованих звітів («Наряди», «Склад», «Взаєморозрахунки», «Завантаженість», «Рентабельність»,
// «Виручка», «P&L») — винесено з page.tsx, щоб формат файла можна було тестувати (тест — __tests__/report-csv.test.ts).

import type { TFunction } from 'i18next';
import type { ApiSchema } from '@sto/shared';
import { escapeCsvCell } from '@/lib/utils';
import { buildRevenueCsv } from './RevenueReport';
import { buildPnlCsv } from './PnlReport';

// Форми звітів — ЗІ ЗГЕНЕРОВАНИХ схем, не рукописні: зміна на беку ламає компіляцію тут, а не дає
// тихий undefined у клітинці (клас бага «колонка Бренд завжди —»).
type ProfitabilityData = ApiSchema<'ProfitabilityReportDto'>;

// `_tab` додається на клієнті (useReport повертає тіло без дискримінанта), тож
// union будується як «DTO + мітка вкладки».
export type ReportData =
  | ({ _tab: 'revenue' } & ApiSchema<'RevenueReportDto'>)
  | ({ _tab: 'work-orders' } & ApiSchema<'WorkOrdersReportDto'>)
  | ({ _tab: 'stock' } & ApiSchema<'StockReportDto'>)
  | ({ _tab: 'settlements' } & ApiSchema<'SettlementsReportDto'>)
  | ({ _tab: 'load' } & ApiSchema<'LoadReportDto'>)
  | ({ _tab: 'profitability' } & ProfitabilityData)
  | ({ _tab: 'pnl' } & ApiSchema<'PnlReportDto'>)
  | ({ _tab: 'vat' } & ApiSchema<'VatReportDto'>);

/** Один знак після коми, але ЧИСЛОМ: escapeCsvCell пише його з десятковою комою, як решту чисел
 *  файла (рядок `toFixed(1)` лишав крапку — Excel з українськими налаштуваннями читав «1.5» датою). */
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Два знаки: сума нормо-годин приходить з хвостом двійкового дробу (478.28000000000014). */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** CSV вкладки фіксованих звітів (роздільник `;`, числа — числами: escapeCsvCell пише їх з комою). */
export function buildCsv(tab: string, data: ReportData, t: TFunction<'reports'>): string {
  if (tab === 'revenue' && data._tab === 'revenue') return buildRevenueCsv(data, t);
  if (tab === 'pnl' && data._tab === 'pnl') return buildPnlCsv(data, t);
  if (tab === 'work-orders' && data._tab === 'work-orders') {
    const rows = [
      [t('page.csv.mechanic'), t('page.csv.normoHours'), t('page.csv.lines'), t('page.csv.amount')],
      ...data.rows.map(r => [
        r.employeeName,
        round2(r.totalNormoHours),
        r.linesCount,
        r.totalAmount,
      ]),
    ];
    return rows.map(r => r.map(c => escapeCsvCell(c)).join(';')).join('\n');
  }
  if (tab === 'stock' && data._tab === 'stock') {
    const rows = [
      [
        t('page.csv.good'),
        t('page.csv.warehouse'),
        t('page.csv.quantity'),
        t('page.csv.available'),
        t('page.csv.costValue'),
        t('page.csv.saleValue'),
      ],
      ...data.stockItems.map(i => [
        i.goodName,
        i.warehouseName,
        i.quantity,
        i.available,
        i.costValue,
        i.saleValue,
      ]),
    ];
    return rows.map(r => r.map(c => escapeCsvCell(c)).join(';')).join('\n');
  }
  if (tab === 'settlements' && data._tab === 'settlements') {
    const rows = [
      [t('page.csv.counterparty'), t('page.csv.balance')],
      ...data.rows.map(r => [r.counterpartyName, r.balance]),
    ];
    return rows.map(r => r.map(c => escapeCsvCell(c)).join(';')).join('\n');
  }
  if (tab === 'load' && data._tab === 'load') {
    const rows = [
      [
        t('page.csv.lift'),
        t('page.csv.zone'),
        t('page.csv.slots'),
        t('page.csv.hours'),
        t('page.csv.capacityHours'),
        t('page.csv.loadPercent'),
      ],
      ...data.rows.map(r => [
        r.liftName,
        r.zoneName,
        r.totalSlots,
        round1(r.totalHours),
        round1(r.capacityHours),
        r.loadPercent,
      ]),
    ];
    return rows.map(r => r.map(c => escapeCsvCell(c)).join(';')).join('\n');
  }
  if (tab === 'profitability' && data._tab === 'profitability') {
    const rows = [
      [t('page.csv.indicator'), t('page.csv.amount'), t('page.csv.pctOfRevenue')],
      [t('page.csv.profRevenue'), data.totalRevenue, 100],
      [
        t('page.csv.profParts'),
        data.totalCostParts,
        data.totalRevenue > 0 ? round1((data.totalCostParts / data.totalRevenue) * 100) : 0,
      ],
      [
        t('page.csv.profLabor'),
        data.totalCostLabor,
        data.totalRevenue > 0 ? round1((data.totalCostLabor / data.totalRevenue) * 100) : 0,
      ],
      [t('page.csv.grossProfit'), data.grossProfit, round1(data.margin)],
      [t('page.csv.profVat'), data.totalVat, ''],
      [t('page.csv.profRevenueWithVat'), data.totalRevenueWithVat, ''],
    ];
    return rows.map(r => r.map(c => escapeCsvCell(c)).join(';')).join('\n');
  }
  if (tab === 'vat' && data._tab === 'vat') {
    // Bug #977: гілки «ПДВ» не було — кнопка «Експорт CSV» на вкладці давала файл з одним BOM.
    const rows = [
      [t('page.csv.indicator'), t('page.csv.amount')],
      [t('page.vat.invoiced'), data.invoiced],
      [t('page.vat.purchases'), data.purchases],
      [t('page.vat.net'), data.net],
    ];
    return rows.map(r => r.map(c => escapeCsvCell(c)).join(';')).join('\n');
  }
  return '';
}
