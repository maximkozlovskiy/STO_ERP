/**
 * Читання переліку товарів із файла (XLSX / CSV) для єдиного пошуку товару (BR-GOOD-008).
 *
 * Mutation-verify:
 *  · `mapColumns` завжди повертає порядок шаблону → кейси про заголовки в довільному порядку падають;
 *  · прибрати фільтр «рядок без жодного ключа» → кейс про порожні рядки падає;
 *  · `rowIndex: i + 2` → `i + 1` → кейс про номер рядка падає;
 *  · прибрати `;` з роздільників CSV → кейс про «;» падає;
 *  · повернути `delimiter: [',', ';']` → кейс «коми в назві без лапок» падає;
 *  · `HEADER_ALIASES[key]` без `Object.hasOwn` → кейс про «constructor» падає.
 *
 * BR-GOOD-013 — заголовок, кодування, аркуш (mutation-verify 2026-11-05):
 *  · `findHeader` завжди повертає рядок 0 (як було) → кейси «без заголовків», «шапка прайсу» падають;
 *  · без межі `HEADER_SCAN_ROWS` → кейс «лише в перших 20 рядках» падає;
 *  · `findHeader` бере перший рядок із хоч однією назвою, а не з найбільшою кількістю → кейс
 *    «реквізити в шапці підписами» падає;
 *  · `decodeTextFile` завжди UTF-8 → кейс про Windows-1251 падає;
 *  · `detectDelimiter` лише за першим рядком → кейс «шапка з комами» в CSV падає;
 *  · `skip_empty_lines: true` → номер рядка CSV під порожнім рядком падає;
 *  · `workbook.worksheets[0]` замість вибору аркуша → обидва кейси про аркуші падають;
 *  · без пропуску прихованих аркушів → кейс про прихований аркуш падає;
 *  · без перевірки NUL-байтів → кейс «двійковий вміст у .csv» падає.
 *  · без пропуску підписів із двокрапкою в `recognisedColumns` → кейс Bug #1043 падає;
 *  · `detectDelimiter` без кроку «за рядком заголовків» (лише підрахунок знаків) → кейс Bug #1044 падає.
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { BadRequestException } from '@nestjs/common';
import { parseGoodRefRows } from './good-ref-rows.parser';
import { XlsxService } from './xlsx.service';

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Товари');
  rows.forEach(r => sheet.addRow(r));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const csv = (text: string): Buffer => Buffer.from(text, 'utf-8');

/** Кодування Windows-1251 для тексту з кирилицею й латиницею (досить для тестових рядків). */
function cp1251(text: string): Buffer {
  const extra: Record<string, number> = { Ґ: 0xa5, ґ: 0xb4, Є: 0xaa, є: 0xba, І: 0xb2, і: 0xb3 };
  Object.assign(extra, { Ї: 0xaf, ї: 0xbf, '«': 0xab, '»': 0xbb, '№': 0xb9 });
  return Buffer.from(
    Array.from(text, ch => {
      const code = ch.charCodeAt(0);
      if (code < 0x80) return code;
      if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0;
      const byte = extra[ch];
      if (byte === undefined) throw new Error(`cp1251: немає символу ${ch}`);
      return byte;
    }),
  );
}

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

  // guards: BR-GOOD-013
  it('заголовки не впізнано → порядок шаблону, і перший рядок — теж дані', async () => {
    const buf = await xlsx([
      ['стовпець 1', 'стовпець 2', 'стовпець 3'],
      ['K1', 'A1', 'Febi'],
    ]);
    // Невпізнаний «заголовок» стає рядком даних: його покаже «не знайдено», а не з'їсть читач.
    expect(await parseGoodRefRows(buf, 'xlsx')).toEqual([
      {
        rowIndex: 1,
        code: 'стовпець 1',
        article: 'стовпець 2',
        brand: 'стовпець 3',
        barcode: null,
        name: null,
      },
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
  it('CSV через «;» з комами в назві без лапок: колонки не з’їжджають', async () => {
    const rows = await parseGoodRefRows(
      csv('Назва;Артикул;Штрихкод\nФільтр, масляний, MANN;W 712/75;4011558729707\n'),
      'csv',
    );
    expect(rows).toEqual([
      {
        rowIndex: 2,
        code: null,
        article: 'W 712/75',
        brand: null,
        barcode: '4011558729707',
        name: 'Фільтр, масляний, MANN',
      },
    ]);
  });

  // guards: BR-GOOD-008
  it('CSV через «,» з «;» у значенні й лапками навколо коми', async () => {
    const rows = await parseGoodRefRows(csv('sku,name\nA1,"Олива 5W-40, 4 л; синтетика"\n'), 'csv');
    expect(rows).toMatchObject([{ article: 'A1', name: 'Олива 5W-40, 4 л; синтетика' }]);
  });

  // guards: BR-GOOD-008
  it('заголовок, що збігається з назвою властивості об’єкта («constructor»), — не поле', async () => {
    const buf = await xlsx([
      ['constructor', 'toString', 'valueOf'],
      ['K1', 'A1', 'Febi'],
    ]);
    // Жодного впізнаного заголовка → порядок шаблону з першого рядка; обидва рядки прочитано.
    expect(await parseGoodRefRows(buf, 'xlsx')).toEqual([
      {
        rowIndex: 1,
        code: 'constructor',
        article: 'toString',
        brand: 'valueOf',
        barcode: null,
        name: null,
      },
      { rowIndex: 2, code: 'K1', article: 'A1', brand: 'Febi', barcode: null, name: null },
    ]);
  });

  // guards: BR-GOOD-008
  it('файл лише із заголовком або порожній → жодного рядка', async () => {
    expect(await parseGoodRefRows(await xlsx([['Артикул']]), 'xlsx')).toEqual([]);
    expect(await parseGoodRefRows(csv(''), 'csv')).toEqual([]);
  });

  // guards: BR-GOOD-013
  it('файл без рядка заголовків: перший товар не губиться, колонки — у порядку шаблону', async () => {
    const buf = await xlsx([
      ['ТВ-1', 'OC 90', 'Knecht', '4820123456789', 'Фільтр оливи'],
      ['ТВ-2', 'BP-1', 'Bosch', '', 'Колодки'],
    ]);
    expect(await parseGoodRefRows(buf, 'xlsx')).toEqual([
      {
        rowIndex: 1,
        code: 'ТВ-1',
        article: 'OC 90',
        brand: 'Knecht',
        barcode: '4820123456789',
        name: 'Фільтр оливи',
      },
      {
        rowIndex: 2,
        code: 'ТВ-2',
        article: 'BP-1',
        brand: 'Bosch',
        barcode: null,
        name: 'Колодки',
      },
    ]);
    // Те саме для CSV: перший запис — дані.
    const rows = await parseGoodRefRows(csv('ТВ-1;OC 90;Knecht\nТВ-2;BP-1;Bosch\n'), 'csv');
    expect(rows.map(r => [r.rowIndex, r.code, r.article, r.brand])).toEqual([
      [1, 'ТВ-1', 'OC 90', 'Knecht'],
      [2, 'ТВ-2', 'BP-1', 'Bosch'],
    ]);
  });

  // guards: BR-GOOD-013
  it('шапка прайсу над таблицею: заголовок знаходиться нижче, рядки шапки — не дані', async () => {
    const buf = await xlsx([
      ['Прайс-лист ТОВ «Автодеталь»'],
      ['Станом на 01.11.2026'],
      [],
      ['№', 'Найменування', 'Виробник', 'Артикул', 'Ціна'],
      [1, 'Фільтр оливи', 'Knecht', 'OC 90', 250],
      [2, 'Колодки', 'Bosch', 'BP-1', 900],
    ]);
    expect(await parseGoodRefRows(buf, 'xlsx')).toEqual([
      {
        rowIndex: 5,
        code: null,
        article: 'OC 90',
        brand: 'Knecht',
        barcode: null,
        name: 'Фільтр оливи',
      },
      { rowIndex: 6, code: null, article: 'BP-1', brand: 'Bosch', barcode: null, name: 'Колодки' },
    ]);
    // CSV: шапка з комами не збиває роздільник «;» таблиці під нею; номер — як рядок Excel.
    const rows = await parseGoodRefRows(
      csv('Прайс, ТОВ «Автодеталь», м. Київ\n\nАртикул;Бренд;Назва\nOC 90;Knecht;Фільтр\n'),
      'csv',
    );
    expect(rows).toEqual([
      { rowIndex: 4, code: null, article: 'OC 90', brand: 'Knecht', barcode: null, name: 'Фільтр' },
    ]);
  });

  // guards: BR-GOOD-013
  it('реквізити в шапці підписами («Назва:», «Код:») не забирають роль заголовка в таблиці', async () => {
    const buf = await xlsx([
      ['Назва:', 'ТОВ «Автодеталь»'],
      ['Код:', '12345678'],
      [],
      ['№', 'Найменування', 'Виробник', 'Артикул'],
      [1, 'Фільтр оливи', 'Knecht', 'OC 90'],
    ]);
    // Заголовок — рядок із найбільшою кількістю впізнаних назв (3), а не перший із хоч однією.
    expect(await parseGoodRefRows(buf, 'xlsx')).toEqual([
      {
        rowIndex: 5,
        code: null,
        article: 'OC 90',
        brand: 'Knecht',
        barcode: null,
        name: 'Фільтр оливи',
      },
    ]);
  });

  // guards: BR-GOOD-013
  it('Bug #1043: реквізит «Назва:» не перемагає таблицю з однією впізнаною колонкою', async () => {
    // Рахунок 1 : 1 — без правила «підпис із двокрапкою — не назва колонки» вищий рядок (шапка)
    // ставав заголовком, артикули читались як назви, і жоден товар не знаходився.
    const text = 'Назва:;ТОВ «Тест»\n\nАртикул;Кількість\nA1;2\nA2;3\n';
    const expected = [
      { rowIndex: 4, code: null, article: 'A1', brand: null, barcode: null, name: null },
      { rowIndex: 5, code: null, article: 'A2', brand: null, barcode: null, name: null },
    ];
    expect(await parseGoodRefRows(csv(text), 'csv')).toEqual(expected);
    const buf = await xlsx([
      ['Код:', '12345678'],
      [],
      ['Артикул', 'Кількість'],
      ['A1', 2],
      ['A2', 3],
    ]);
    expect(await parseGoodRefRows(buf, 'xlsx')).toEqual(expected);
  });

  // guards: BR-GOOD-013
  it('Bug #1044: CSV через «;» у дві колонки, у назвах кілька ком без лапок — роздільник «;»', async () => {
    // Ком у назвах більше, ніж «;» між колонками: роздільник за підрахунком знаків обирав «,».
    const text = 'Артикул;Назва\nOC 90;Фільтр, оливи, Knecht, 1.6\nBP-1;Колодки, передні, Bosch\n';
    expect(await parseGoodRefRows(csv(text), 'csv')).toEqual([
      {
        rowIndex: 2,
        code: null,
        article: 'OC 90',
        brand: null,
        barcode: null,
        name: 'Фільтр, оливи, Knecht, 1.6',
      },
      {
        rowIndex: 3,
        code: null,
        article: 'BP-1',
        brand: null,
        barcode: null,
        name: 'Колодки, передні, Bosch',
      },
    ]);
  });

  // guards: BR-GOOD-013
  it('рядок заголовків шукається лише в перших 20 рядках', async () => {
    const filler = Array.from({ length: 20 }, (_, i) => [`K${i + 1}`]);
    const rows = await parseGoodRefRows(await xlsx([...filler, ['Артикул'], ['A1']]), 'xlsx');
    // 21-й рядок «Артикул» — уже дані, а не заголовок: файл читається в порядку шаблону.
    expect(rows).toHaveLength(22);
    expect(rows[20]).toMatchObject({ rowIndex: 21, code: 'Артикул' });
  });

  // guards: BR-GOOD-013
  it('CSV у Windows-1251 (так зберігає Excel у кириличній Windows): кирилиця читається', async () => {
    const text = 'Код;Артикул;Бренд;Назва\nТВ-1;OC 90;Кнехт;Фільтр оливи ґ Є ї\n';
    expect(await parseGoodRefRows(cp1251(text), 'csv')).toEqual([
      {
        rowIndex: 2,
        code: 'ТВ-1',
        article: 'OC 90',
        brand: 'Кнехт',
        barcode: null,
        name: 'Фільтр оливи ґ Є ї',
      },
    ]);
    // UTF-8 без BOM — як і раніше UTF-8.
    expect((await parseGoodRefRows(csv(text), 'csv'))[0]?.name).toBe('Фільтр оливи ґ Є ї');
  });

  // guards: BR-GOOD-013
  it('двійковий вміст у .csv (NUL-байти, напр. «Юнікод-текст» UTF-16) → 400, а не сміттєві рядки', async () => {
    const utf16 = Buffer.from('Артикул\nA1\n', 'utf16le');
    const err = await parseGoodRefRows(utf16, 'csv').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toContain('Не вдалося прочитати файл');
  });

  // guards: BR-GOOD-013
  it('книга з кількома аркушами: аркуш із заголовками; прихований аркуш пропускається', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Про прайс').addRow(['Прайс-лист на листопад']);
    const hidden = workbook.addWorksheet('Довідник', { state: 'hidden' });
    hidden.addRow(['Артикул']);
    hidden.addRow(['HIDDEN-1']);
    const data = workbook.addWorksheet('Товари');
    data.addRow(['Артикул', 'Бренд']);
    data.addRow(['A1', 'Bosch']);
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await parseGoodRefRows(buf, 'xlsx')).toEqual([
      { rowIndex: 2, code: null, article: 'A1', brand: 'Bosch', barcode: null, name: null },
    ]);
  });

  // guards: BR-GOOD-013
  it('книга без заголовків: перший аркуш, де є дані (порожній перший аркуш не заважає)', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Аркуш1');
    workbook.addWorksheet('Аркуш2').addRow(['K1', 'A1']);
    workbook.addWorksheet('Аркуш3').addRow(['K9', 'A9']);
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await parseGoodRefRows(buf, 'xlsx')).toEqual([
      { rowIndex: 1, code: 'K1', article: 'A1', brand: null, barcode: null, name: null },
    ]);
  });

  // Bug #833: файл не того формату — помилка файла користувача (400 з поясненням), а не 500.
  it('не-Excel із розширенням .xlsx (текст, картинка, порожній) → 400 «не вдалося прочитати»', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    for (const buf of [csv('це не excel\n1,2,3\n'), png, csv('')]) {
      const err = await parseGoodRefRows(buf, 'xlsx').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toContain('Не вдалося прочитати файл');
    }
  });

  it('Bug #833: xlsx-вміст із розширенням .csv → 400, а не виняток розбору CSV', async () => {
    const buf = await xlsx([['Артикул'], ['A1']]);
    await expect(parseGoodRefRows(buf, 'csv')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('Bug #833: решта завантажень XLSX (товари, роботи, бренди, одиниці, рядки документа) → 400', async () => {
    const bad = csv('це не excel');
    const svc = XlsxService.prototype;
    for (const parse of [
      svc.parseGoods,
      svc.parseWorks,
      svc.parseBrands,
      svc.parseUnits,
      svc.parsePOLines,
    ]) {
      // Файл відкривається першим рядком методу, до будь-якого звертання до `this`.
      await expect(parse.call({} as XlsxService, bad)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
