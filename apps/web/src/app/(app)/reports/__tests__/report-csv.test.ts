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
});
