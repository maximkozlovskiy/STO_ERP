import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import i18n from '@/i18n/config';
import type { GroupNode, ReportRunResult } from '@/hooks/api/useReportBuilder';
import {
  CSV_BOM,
  aggAliasLabel,
  buildCsvText,
  buildExportFile,
  buildExportRows,
  buildXlsxXml,
  exportCell,
  flattenTree,
} from '@/lib/report-export';

// BR-RPT-021 — експорт CSV / XLSX виконує браузер із уже отриманого результату звіту.
// Тут перевіряється ЧИСТА частина (`report-export.ts`): результат → рядки → CSV-текст / SpreadsheetML.
// DOM-частину (`exportReport` → `downloadBlob`) ці тести не чіпають.

/** Справжній український каталог `reports` (i18n ініціалізує setup.ts, мова за замовч. — uk). */
const t = i18n.getFixedT('uk', 'reports') as unknown as TFunction<'reports'>;

/** Вузол дерева груп. `value` у згенерованій схемі — `Record<string, never> | null`, тому cast. */
function node(
  key: string,
  count: number,
  aggregates: Record<string, number | null>,
  children: GroupNode[] = [],
  value: unknown = key,
): GroupNode {
  return {
    key,
    field: 'status',
    label: 'Статус',
    value,
    count,
    aggregates,
    children,
  } as unknown as GroupNode;
}

function makeResult(
  over: Partial<ReportRunResult> & { body?: Partial<ReportRunResult['result']> },
) {
  const { body, ...rest } = over;
  return {
    entity: 'workOrder',
    columns: [],
    groupBy: [],
    aggregations: [],
    ...rest,
    result: {
      tree: [],
      detailRows: [],
      grandTotals: {},
      rowCount: 0,
      truncated: false,
      ...body,
    },
  } as ReportRunResult;
}

/** Груповий звіт: 2 рівні, 2 агрегати, одна «порожня» група. */
function groupedResult(): ReportRunResult {
  return makeResult({
    groupBy: ['branch', 'status'],
    columns: [{ key: 'total', label: 'Сума', type: 'decimal' }],
    aggregations: [
      { field: 'total', agg: 'SUM', type: 'decimal', label: 'Сума' },
      { field: 'price', agg: 'AVG', type: 'decimal', label: 'Ціна' },
    ],
    body: {
      tree: [
        node('Київ', 3, { SUM_total: 300, AVG_price: 100 }, [
          node('Новий', 1, { SUM_total: 100, AVG_price: 100 }),
          node('Закритий', 2, { SUM_total: 200, AVG_price: null }),
        ]),
        node('∅', 2, { SUM_total: 50.5, AVG_price: 25.25 }, [], null),
      ],
      grandTotals: { SUM_total: 350.5, AVG_price: 70.1 },
      rowCount: 5,
    },
  });
}

describe('report-export › дерево груп → плоскі рядки', () => {
  // guards: BR-RPT-021
  it('flattenTree обходить дерево вглиб і відбиває рівень відступом у два пробіли', () => {
    const rows = flattenTree(groupedResult().result.tree, ['SUM_total', 'AVG_price'], t);

    expect(rows).toEqual([
      ['Київ', '3', '300', '100'],
      ['  Новий', '1', '100', '100'],
      ['  Закритий', '2', '200', ''],
      ['(порожньо)', '2', '50.5', '25.25'],
    ]);
  });

  // guards: BR-RPT-021
  it('flattenTree: третій рівень має відступ у чотири пробіли, а колонки агрегатів ідуть у порядку aggAliases', () => {
    const tree = [
      node('A', 4, { SUM_total: 4, AVG_price: 1 }, [
        node('B', 4, { SUM_total: 4, AVG_price: 1 }, [
          node('C', 4, { SUM_total: 4, AVG_price: 1 }),
        ]),
      ]),
    ];

    expect(flattenTree(tree, ['AVG_price', 'SUM_total'], t)).toEqual([
      ['A', '4', '1', '4'],
      ['  B', '4', '1', '4'],
      ['    C', '4', '1', '4'],
    ]);
  });

  // guards: BR-RPT-021
  it('груповий звіт: заголовок, підсумки груп і рядок «Разом» із загальним підсумком', () => {
    const rows = buildExportRows(groupedResult(), t);

    expect(rows[0]).toEqual(['Група', 'Кількість', 'Σ Сума', 'сер. Ціна']);
    expect(rows.slice(1, -1)).toEqual([
      ['Київ', '3', '300', '100'],
      ['  Новий', '1', '100', '100'],
      ['  Закритий', '2', '200', ''],
      ['(порожньо)', '2', '50.5', '25.25'],
    ]);
    // Загальний підсумок — із grandTotals і rowCount, а не сума рядків дерева.
    expect(rows[rows.length - 1]).toEqual(['Разом', '5', '350.5', '70.1']);
  });

  // guards: BR-RPT-021
  it('груповий звіт: загальний підсумок null → порожня клітинка, а не «null»', () => {
    const result = groupedResult();
    result.result.grandTotals = { SUM_total: null, AVG_price: 0 };

    const rows = buildExportRows(result, t);

    expect(rows[rows.length - 1]).toEqual(['Разом', '5', '', '0']);
  });
});

describe('report-export › плоский звіт (без групування)', () => {
  function flatResult(detailRows: Record<string, unknown>[]): ReportRunResult {
    return makeResult({
      columns: [
        { key: 'number', label: 'Номер', type: 'scalar' },
        { key: 'status', label: 'Статус', type: 'enum', enumName: 'InvoiceStatus' },
        { key: 'total', label: 'Сума', type: 'decimal' },
      ],
      aggregations: [{ field: 'total', agg: 'SUM', type: 'decimal', label: 'Сума' }],
      body: { detailRows, grandTotals: { SUM_total: 1750 }, rowCount: 3 },
    });
  }

  // guards: BR-RPT-021
  it('детальні рядки нумеруються з 1, колонки агрегатів у рядках порожні, підсумок — лише в «Разом»', () => {
    const rows = buildExportRows(
      flatResult([
        { number: 'РАХ-1', status: 'PAID', total: 1250 },
        { number: 'РАХ-2', status: 'DRAFT', total: 500 },
      ]),
      t,
    );

    expect(rows).toEqual([
      ['№', 'Номер', 'Статус', 'Сума', 'Σ Сума'],
      ['1', 'РАХ-1', 'Оплачено', '1250', ''],
      ['2', 'РАХ-2', 'Чернетка', '500', ''],
      ['Разом', '', '', '', '1750'],
    ]);
  });

  // guards: BR-RPT-021
  it('є склеєні рядки (__mergedCount > 1) → колонка «Склеєно»; рядок без лічильника = 1; у «Разом» — rowCount', () => {
    const rows = buildExportRows(
      flatResult([
        { number: 'РАХ-1', status: 'PAID', total: 1250, __mergedCount: 2 },
        { number: 'РАХ-2', status: 'DRAFT', total: 500 },
      ]),
      t,
    );

    expect(rows).toEqual([
      ['№', 'Номер', 'Статус', 'Сума', 'Склеєно', 'Σ Сума'],
      ['1', 'РАХ-1', 'Оплачено', '1250', '2', ''],
      ['2', 'РАХ-2', 'Чернетка', '500', '1', ''],
      ['Разом', '', '', '', '3', '1750'],
    ]);
  });

  // guards: BR-RPT-021
  it('усі __mergedCount = 1 → колонки «Склеєно» немає', () => {
    const rows = buildExportRows(
      flatResult([{ number: 'РАХ-1', status: 'PAID', total: 1250, __mergedCount: 1 }]),
      t,
    );

    expect(rows[0]).toEqual(['№', 'Номер', 'Статус', 'Сума', 'Σ Сума']);
    expect(rows[1]).toEqual(['1', 'РАХ-1', 'Оплачено', '1250', '']);
  });
});

describe('report-export › значення клітинки (exportCell)', () => {
  // guards: BR-RPT-021
  it('enum → переклад мовою інтерфейсу; невідомий enumName → сире значення', () => {
    expect(exportCell('PAID', 'enum', 'InvoiceStatus', t)).toBe('Оплачено');
    expect(exportCell('SOMETHING', 'enum', 'NoSuchEnum', t)).toBe('SOMETHING');
  });

  // guards: BR-RPT-021
  it('boolean → «Так» / «Ні» (false не зникає в порожню клітинку)', () => {
    expect(exportCell(true, 'boolean', undefined, t)).toBe('Так');
    expect(exportCell(false, 'boolean', undefined, t)).toBe('Ні');
  });

  // guards: BR-RPT-021
  it('дата → ДД.ММ.РРРР', () => {
    expect(exportCell('2026-03-05T10:00:00.000Z', 'date', undefined, t)).toBe('05.03.2026');
  });

  // guards: BR-RPT-021
  it('null / undefined → порожня клітинка; число лишається сирим (без форматування грошей)', () => {
    expect(exportCell(null, 'decimal', undefined, t)).toBe('');
    expect(exportCell(undefined, 'scalar', undefined, t)).toBe('');
    expect(exportCell(null, 'boolean', undefined, t)).toBe('');
    expect(exportCell(1250.5, 'decimal', undefined, t)).toBe('1250.5');
    expect(exportCell(0, 'number', undefined, t)).toBe('0');
  });
});

describe('report-export › підпис колонки агрегату (aggAliasLabel)', () => {
  // guards: BR-RPT-021
  it('короткий префікс агрегації + підпис поля: з aggregations, далі з columns, далі сам ключ поля', () => {
    const result = makeResult({
      columns: [{ key: 'qty', label: 'Кількість', type: 'number' }],
      aggregations: [{ field: 'documentDate', agg: 'MIN', type: 'date', label: 'Дата документа' }],
    });

    // поле агрегату НЕ серед колонок — підпис із aggregations
    expect(aggAliasLabel('MIN_documentDate', result, t)).toBe('мін. Дата документа');
    // поля немає в aggregations — підпис із columns
    expect(aggAliasLabel('MAX_qty', result, t)).toBe('макс. Кількість');
    // поля немає ніде — ключ поля (з підкресленнями всередині лишається цілим)
    expect(aggAliasLabel('SUM_unit_price', result, t)).toBe('Σ unit_price');
  });
});

describe('report-export › CSV', () => {
  // guards: BR-RPT-021
  it('роздільник клітинок — кома, рядків — \\n; без завершального переносу', () => {
    expect(
      buildCsvText([
        ['Група', 'Кількість'],
        ['Київ', '3'],
      ]),
    ).toBe('Група,Кількість\nКиїв,3');
  });

  // guards: BR-RPT-021
  it('клітинка з комою, лапками чи переносом береться в лапки, лапки подвоюються', () => {
    expect(buildCsvText([['ТОВ "Альфа", Київ', 'a;b', 'рядок1\nрядок2']])).toBe(
      '"ТОВ ""Альфа"", Київ",a;b,"рядок1\nрядок2"',
    );
  });

  // guards: BR-RPT-021
  it('захист від формул: клітинки на =, +, -, @ отримують апостроф (escapeCsvCell)', () => {
    expect(buildCsvText([['=1+1', '+380501234567', '-cmd', '@SUM(A1)', 'звичайний']])).toBe(
      "'=1+1,'+380501234567,'-cmd,'@SUM(A1),звичайний",
    );
    // формула з комою: і апостроф, і лапки
    expect(buildCsvText([['=HYPERLINK("http://evil","x")']])).toBe(
      '"\'=HYPERLINK(""http://evil"",""x"")"',
    );
  });

  // guards: BR-RPT-021
  it('назва групи з формулою в дереві звіту не доходить до CSV сирою', () => {
    const result = makeResult({
      groupBy: ['name'],
      body: { tree: [node('=cmd|calc', 1, {})], rowCount: 1 },
    });

    const lines = buildExportFile(result, 'csv', t).content.split('\n');

    expect(lines[1]).toBe("'=cmd|calc,1");
  });

  // guards: BR-RPT-021
  it('файл CSV: BOM на початку (кирилиця в Excel), MIME text/csv, назва report-<сутність>.csv', () => {
    const file = buildExportFile(groupedResult(), 'csv', t);

    expect(CSV_BOM).toBe('﻿');
    expect(file.content.startsWith('﻿Група,Кількість,Σ Сума,сер. Ціна\n')).toBe(true);
    expect(file.content.endsWith('\nРазом,5,350.5,70.1')).toBe(true);
    expect(file.mime).toBe('text/csv;charset=utf-8;');
    expect(file.filename).toBe('report-workOrder.csv');
  });
});

describe('report-export › XLSX (SpreadsheetML)', () => {
  /** Вміст усіх <Row> як масив рядків XML. */
  const xmlRows = (xml: string) => xml.match(/<Row>.*?<\/Row>/g) ?? [];

  // guards: BR-RPT-021
  it('екранує & < > у тексті; лапки в тексті клітинки лишаються як є (це вміст елемента, не атрибут)', () => {
    const xml = buildXlsxXml([['ТОВ "Альфа" & <Ко> > 1']], t);

    expect(xmlRows(xml)).toEqual([
      '<Row><Cell><Data ss:Type="String">ТОВ "Альфа" &amp; &lt;Ко&gt; &gt; 1</Data></Cell></Row>',
    ]);
  });

  // guards: BR-RPT-021
  it('амперсанд екранується першим — готова сутність не псується подвійно і тег не проходить', () => {
    const xml = buildXlsxXml([['x', '</Data><Evil/>', 'a&lt;b']], t);

    expect(xml).not.toContain('<Evil/>');
    expect(xml).toContain('<Data ss:Type="String">&lt;/Data&gt;&lt;Evil/&gt;</Data>');
    expect(xml).toContain('<Data ss:Type="String">a&amp;lt;b</Data>');
  });

  // guards: BR-RPT-021
  it('числа йдуть як Number, а не String: цілі, дробові, від’ємні, нуль', () => {
    const xml = buildXlsxXml([['Київ', '3', '350.5', '-12', '0']], t);

    expect(xmlRows(xml)).toEqual([
      '<Row>' +
        '<Cell><Data ss:Type="String">Київ</Data></Cell>' +
        '<Cell><Data ss:Type="Number">3</Data></Cell>' +
        '<Cell><Data ss:Type="Number">350.5</Data></Cell>' +
        '<Cell><Data ss:Type="Number">-12</Data></Cell>' +
        '<Cell><Data ss:Type="Number">0</Data></Cell>' +
        '</Row>',
    ]);
  });

  // guards: BR-RPT-021
  it('перша колонка завжди String (навіть число), порожня клітинка і текст — String', () => {
    const xml = buildXlsxXml([['2026', '', 'РАХ-1', '05.03.2026']], t);

    expect(xmlRows(xml)).toEqual([
      '<Row>' +
        '<Cell><Data ss:Type="String">2026</Data></Cell>' +
        '<Cell><Data ss:Type="String"></Data></Cell>' +
        '<Cell><Data ss:Type="String">РАХ-1</Data></Cell>' +
        '<Cell><Data ss:Type="String">05.03.2026</Data></Cell>' +
        '</Row>',
    ]);
  });

  // guards: BR-RPT-021
  it('заголовок — перший рядок, клітинки-рядки; далі дані й «Разом» у тому самому порядку', () => {
    const file = buildExportFile(groupedResult(), 'xlsx', t);
    const rows = xmlRows(file.content);

    expect(rows).toHaveLength(6);
    expect(rows[0]).toBe(
      '<Row>' +
        '<Cell><Data ss:Type="String">Група</Data></Cell>' +
        '<Cell><Data ss:Type="String">Кількість</Data></Cell>' +
        '<Cell><Data ss:Type="String">Σ Сума</Data></Cell>' +
        '<Cell><Data ss:Type="String">сер. Ціна</Data></Cell>' +
        '</Row>',
    );
    expect(rows[5]).toBe(
      '<Row>' +
        '<Cell><Data ss:Type="String">Разом</Data></Cell>' +
        '<Cell><Data ss:Type="Number">5</Data></Cell>' +
        '<Cell><Data ss:Type="Number">350.5</Data></Cell>' +
        '<Cell><Data ss:Type="Number">70.1</Data></Cell>' +
        '</Row>',
    );
  });

  // guards: BR-RPT-021
  it('каркас книги: пролог, простори імен SpreadsheetML, аркуш «Звіт»; файл — report-<сутність>.xls', () => {
    const file = buildExportFile(groupedResult(), 'xlsx', t);

    expect(
      file.content.startsWith('<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n'),
    ).toBe(true);
    expect(file.content).toContain(
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
    );
    expect(file.content).toContain('<Worksheet ss:Name="Звіт"><Table><Row>');
    expect(file.content.endsWith('</Row></Table></Worksheet></Workbook>')).toBe(true);
    expect(file.content.startsWith('﻿')).toBe(false);
    expect(file.mime).toBe('application/vnd.ms-excel');
    expect(file.filename).toBe('report-workOrder.xls');
  });
});
