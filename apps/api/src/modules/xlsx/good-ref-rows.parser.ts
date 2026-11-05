import { parse as parseCSV } from 'csv-parse/sync';
import type { Worksheet } from 'exceljs';
import { loadXlsxWorkbook, tableFileUnreadable } from './load-workbook';
import { decodeTextFile } from './decode-text-file';

/** Рядок файла-переліку товарів: усе, за чим товар можна впізнати (BR-GOOD-008). */
export interface GoodRefRow {
  /** Номер рядка у файлі, як його бачить користувач (у CSV — номер запису, як рядок Excel). */
  rowIndex: number;
  code: string | null;
  article: string | null;
  brand: string | null;
  barcode: string | null;
  name: string | null;
}

type Field = 'code' | 'article' | 'brand' | 'barcode' | 'name';

/** Порядок колонок, коли заголовки не впізнано (так викладено шаблон). */
const DEFAULT_ORDER: Field[] = ['code', 'article', 'brand', 'barcode', 'name'];

/** Заголовок → поле. Ключі вже нормалізовані: нижній регістр, лише літери й цифри. */
const HEADER_ALIASES: Record<string, Field> = {
  код: 'code',
  кодтовару: 'code',
  внутрішнійкод: 'code',
  code: 'code',
  internalcode: 'code',
  артикул: 'article',
  артикулsku: 'article',
  арт: 'article',
  sku: 'article',
  article: 'article',
  бренд: 'brand',
  виробник: 'brand',
  brand: 'brand',
  manufacturer: 'brand',
  штрихкод: 'barcode',
  barcode: 'barcode',
  ean: 'barcode',
  назва: 'name',
  назватовару: 'name',
  найменування: 'name',
  name: 'name',
};

const headerKey = (s: string): string => s.toLocaleLowerCase('uk').replace(/[^\p{L}\p{N}]/gu, '');

/** Скільки рядків від початку аркуша шукати рядок заголовків (шапка прайсу над таблицею). */
const HEADER_SCAN_ROWS = 20;

/** Рядок сітки з номером, як його бачить користувач (1-based). */
type GridRow = { rowNo: number; cells: string[] };

/** Колонка (0-based) → поле — лише за впізнаними заголовками. */
function recognisedColumns(cells: string[]): Map<number, Field> {
  const map = new Map<number, Field>();
  cells.forEach((h, i) => {
    const key = headerKey(h);
    // Лише власні ключі: заголовок «constructor» чи «toString» інакше дав би «поле»-функцію
    // з прототипа і рядок даних прийнявся б за заголовок.
    const field = Object.hasOwn(HEADER_ALIASES, key) ? HEADER_ALIASES[key] : undefined;
    if (field && !Array.from(map.values()).includes(field)) map.set(i, field);
  });
  return map;
}

/**
 * Рядок заголовків — той із перших `HEADER_SCAN_ROWS`, де впізнано НАЙБІЛЬШЕ назв колонок; за
 * рівності — вищий (BR-GOOD-013). Не «перший із хоч однією»: у шапці прайсу реквізити часто
 * стоять підписами в окремій комірці («Назва:» | «ТОВ …», «Код:» | «12345678»), і такий рядок
 * забирав би роль заголовка у справжньої таблиці нижче. Рядки над заголовком — шапка, не дані.
 * Не знайдено → файл без заголовків: усі рядки — дані в порядку шаблону, перший товар не губиться.
 */
function findHeader(grid: GridRow[]): { index: number; columns: Map<number, Field> } | null {
  const limit = Math.min(grid.length, HEADER_SCAN_ROWS);
  let best: { index: number; columns: Map<number, Field> } | null = null;
  for (let i = 0; i < limit; i++) {
    const columns = recognisedColumns(grid[i].cells);
    if (columns.size > (best?.columns.size ?? 0)) best = { index: i, columns };
  }
  return best;
}

function toRows(grid: GridRow[]): GoodRefRow[] {
  const header = findHeader(grid);
  const columns = header?.columns ?? new Map(DEFAULT_ORDER.map((field, i) => [i, field]));
  const rows: GoodRefRow[] = [];
  for (const { rowNo, cells } of grid.slice(header ? header.index + 1 : 0)) {
    const row: GoodRefRow = {
      rowIndex: rowNo,
      code: null,
      article: null,
      brand: null,
      barcode: null,
      name: null,
    };
    for (const [col, field] of columns) {
      const value = (cells[col] ?? '').trim();
      if (value) row[field] = value;
    }
    if (row.code || row.article || row.barcode || row.name) rows.push(row);
  }
  return rows;
}

/**
 * Роздільник CSV — ОДИН на файл, за першими рядками (рядок заголовків може стояти під шапкою):
 * якого знака поза лапками більше. Обидва одразу (`[',', ';']`) різали значення: Excel в
 * українській локалі пише через «;» і коми в назві («Фільтр, масляний») у лапки не бере —
 * колонки з'їжджали, і в поле артикула чи штрихкоду потрапляв шматок назви.
 */
function detectDelimiter(text: string): ',' | ';' {
  let commas = 0;
  let semicolons = 0;
  for (const line of text.split(/\r?\n/, HEADER_SCAN_ROWS)) {
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === ',') commas++;
      else if (!quoted && ch === ';') semicolons++;
    }
  }
  return semicolons > commas ? ';' : ',';
}

/** Сітка аркуша з номерами рядків Excel; ширина — щонайменше колонки шаблону. */
function sheetGrid(sheet: Worksheet): GridRow[] {
  const grid: GridRow[] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNo) => {
    const cells: string[] = [];
    for (let c = 1; c <= Math.max(row.cellCount, DEFAULT_ORDER.length); c++) {
      cells.push(row.getCell(c).text ?? '');
    }
    grid.push({ rowNo, cells });
  });
  return grid;
}

/**
 * Читає перелік товарів із XLSX або CSV (BR-GOOD-008, BR-GOOD-013). Колонки впізнаються за
 * назвою («Код», «Артикул», «Бренд», «Штрихкод», «Назва» та їхні англійські відповідники) у
 * будь-якому порядку; рядок заголовків шукається в перших рядках (над ним може бути шапка), а
 * файл без заголовків читається з першого рядка в порядку шаблону. CSV — у UTF-8 або
 * Windows-1251. З книги береться видимий аркуш із рядком заголовків, а якщо такого немає —
 * перший видимий аркуш, де є дані. Рядки без жодного ключа товару пропускаються.
 */
export async function parseGoodRefRows(
  buffer: Buffer | Uint8Array,
  fileType: 'xlsx' | 'csv',
): Promise<GoodRefRow[]> {
  if (fileType === 'csv') {
    const text = decodeTextFile(buffer);
    let records: string[][];
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- parseCSV повертає unknown[]; каст потрібен tsc
      records = parseCSV(text, {
        // Порожні рядки лишаються записами: номер запису = номер рядка, який покаже Excel.
        skip_empty_lines: false,
        relax_column_count: true,
        trim: true,
        // Excel в українській локалі зберігає CSV через «;».
        delimiter: detectDelimiter(text),
      }) as string[][];
    } catch {
      // Не CSV: csv-parse кидає на «лапках» усередині значення.
      throw tableFileUnreadable();
    }
    return toRows(records.map((r, i) => ({ rowNo: i + 1, cells: r.map(c => String(c ?? '')) })));
  }

  const workbook = await loadXlsxWorkbook(buffer);
  let firstWithData: GoodRefRow[] = [];
  for (const sheet of workbook.worksheets) {
    // Прихований аркуш — довідник чи службові дані книги, не перелік товарів.
    if (sheet.state !== 'visible') continue;
    const grid = sheetGrid(sheet);
    if (findHeader(grid)) return toRows(grid);
    if (firstWithData.length === 0) firstWithData = toRows(grid);
  }
  return firstWithData;
}
