/**
 * Читання переліку товарів із файла (XLSX / CSV) для єдиного пошуку товару (BR-GOOD-008).
 *
 * Mutation-verify:
 *  · `mapColumns` завжди повертає порядок шаблону → кейси про заголовки в довільному порядку падають;
 *  · прибрати фільтр «рядок без жодного ключа» → кейс про порожні рядки падає;
 *  · `rowIndex: i + 2` → `i + 1` → кейс про номер рядка падає;
 *  · прибрати `;` з роздільників CSV → кейс про «;» падає.
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseGoodRefRows } from './good-ref-rows.parser';

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Товари');
  rows.forEach(r => sheet.addRow(r));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const csv = (text: string): Buffer => Buffer.from(text, 'utf-8');

describe('parseGoodRefRows — перелік товарів із файла', () => {
  // guards: BR-GOOD-008
  it('XLSX за шаблоном: Код, Артикул, Бренд, Штрихкод, Назва', async () => {
    const buf = await xlsx([
      ['Код', 'Артикул', 'Бренд', 'Штрихкод', 'Назва'],
      ['ТВ-1', 'OC 90', 'Knecht', '4820123456789', 'Фільтр оливи'],
    ]);
    expect(await parseGoodRefRows(buf, 'xlsx')).toEqual([
      {
        rowIndex: 2,
        code: 'ТВ-1',
        article: 'OC 90',
        brand: 'Knecht',
        barcode: '4820123456789',
        name: 'Фільтр оливи',
      },
    ]);
  });

  // guards: BR-GOOD-008
  it('колонки впізнаються за заголовком у будь-якому порядку, зайві ігноруються', async () => {
    const buf = await xlsx([
      ['Назва товару', 'К-ть', 'Виробник', 'Артикул (SKU)'],
      ['Колодки', 4, 'Bosch', 'BP-1'],
    ]);
    expect(await parseGoodRefRows(buf, 'xlsx')).toEqual([
      { rowIndex: 2, code: null, article: 'BP-1', brand: 'Bosch', barcode: null, name: 'Колодки' },
    ]);
  });

  // guards: BR-GOOD-008
  it('штрихкод, який Excel зберіг числом, читається повністю, без експоненти', async () => {
    const buf = await xlsx([['Штрихкод'], [4820123456789]]);
    expect((await parseGoodRefRows(buf, 'xlsx'))[0]?.barcode).toBe('4820123456789');
  });

  // guards: BR-GOOD-008
  it('порожні рядки й рядки без ключа товару пропускаються, номер рядка — як у файлі', async () => {
    const buf = await xlsx([
      ['Артикул', 'Бренд'],
      ['A1', 'Bosch'],
      [],
      ['', 'Лише бренд'],
      ['  A2  ', ''],
    ]);
    const rows = await parseGoodRefRows(buf, 'xlsx');
    expect(rows.map(r => [r.rowIndex, r.article, r.brand])).toEqual([
      [2, 'A1', 'Bosch'],
      [5, 'A2', null],
    ]);
  });

  // guards: BR-GOOD-008
  it('заголовки не впізнано → колонки читаються в порядку шаблону', async () => {
    const buf = await xlsx([
      ['стовпець 1', 'стовпець 2', 'стовпець 3'],
      ['K1', 'A1', 'Febi'],
    ]);
    expect(await parseGoodRefRows(buf, 'xlsx')).toEqual([
      { rowIndex: 2, code: 'K1', article: 'A1', brand: 'Febi', barcode: null, name: null },
    ]);
  });

  // guards: BR-GOOD-008
  it('CSV з BOM і англійськими заголовками (старий шаблон «Розцінити список»)', async () => {
    const rows = await parseGoodRefRows(
      csv('﻿sku,barcode,name\nOIL-5W40,,Масло моторне\n,4820123456789,Фільтр\n'),
      'csv',
    );
    expect(rows).toEqual([
      {
        rowIndex: 2,
        code: null,
        article: 'OIL-5W40',
        brand: null,
        barcode: null,
        name: 'Масло моторне',
      },
      {
        rowIndex: 3,
        code: null,
        article: null,
        brand: null,
        barcode: '4820123456789',
        name: 'Фільтр',
      },
    ]);
  });

  // guards: BR-GOOD-008
  it('CSV з роздільником «;» (так зберігає Excel в українській локалі)', async () => {
    const rows = await parseGoodRefRows(csv('Артикул;Бренд\nA1;Бош\n'), 'csv');
    expect(rows).toEqual([
      { rowIndex: 2, code: null, article: 'A1', brand: 'Бош', barcode: null, name: null },
    ]);
  });

  // guards: BR-GOOD-008
  it('файл лише із заголовком або порожній → жодного рядка', async () => {
    expect(await parseGoodRefRows(await xlsx([['Артикул']]), 'xlsx')).toEqual([]);
    expect(await parseGoodRefRows(csv(''), 'csv')).toEqual([]);
  });
});
