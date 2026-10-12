import ExcelJS from 'exceljs';
import { parse as parseCSV } from 'csv-parse/sync';

/** Рядок файла-переліку товарів: усе, за чим товар можна впізнати (BR-GOOD-008). */
export interface GoodRefRow {
  /** Номер рядка у файлі, як його бачить користувач (заголовок — рядок 1). */
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

/** Колонка (0-based) → поле. Жодного впізнаного заголовка → порядок шаблону. */
function mapColumns(headers: string[]): Map<number, Field> {
  const map = new Map<number, Field>();
  headers.forEach((h, i) => {
    const key = headerKey(h);
    // Лише власні ключі: заголовок «constructor» чи «toString» інакше дав би «поле»-функцію
    // з прототипа, порядок шаблону не ввімкнувся б і файл читався б як порожній.
    const field = Object.hasOwn(HEADER_ALIASES, key) ? HEADER_ALIASES[key] : undefined;
    if (field && !Array.from(map.values()).includes(field)) map.set(i, field);
  });
  if (map.size === 0) DEFAULT_ORDER.forEach((field, i) => map.set(i, field));
  return map;
}

function toRows(grid: string[][]): GoodRefRow[] {
  if (grid.length === 0) return [];
  const columns = mapColumns(grid[0]);
  const rows: GoodRefRow[] = [];
  grid.slice(1).forEach((cells, i) => {
    const row: GoodRefRow = {
      rowIndex: i + 2,
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
  });
  return rows;
}

/**
 * Роздільник CSV — ОДИН на файл, за рядком заголовків: якого знака поза лапками більше.
 * Обидва одразу (`[',', ';']`) різали значення: Excel в українській локалі пише через «;» і
 * коми в назві («Фільтр, масляний») у лапки не бере — колонки з'їжджали, і в поле артикула чи
 * штрихкоду потрапляв шматок назви.
 */
function detectDelimiter(text: string): ',' | ';' {
  const header = text.split(/\r?\n/, 1)[0];
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ',') commas++;
    else if (!quoted && ch === ';') semicolons++;
  }
  return semicolons > commas ? ';' : ',';
}

/**
 * Читає перелік товарів із XLSX або CSV. Перший рядок — заголовки; колонки впізнаються за назвою
 * («Код», «Артикул», «Бренд», «Штрихкод», «Назва» та їхні англійські відповідники) у будь-якому
 * порядку. Рядки без жодного ключа товару пропускаються.
 */
export async function parseGoodRefRows(
  buffer: Buffer | Uint8Array,
  fileType: 'xlsx' | 'csv',
): Promise<GoodRefRow[]> {
  if (fileType === 'csv') {
    const text = Buffer.from(buffer).toString('utf-8').replace(/^﻿/, '');
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- parseCSV повертає unknown[]; каст потрібен tsc
    const grid = parseCSV(text, {
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
      // Excel в українській локалі зберігає CSV через «;».
      delimiter: detectDelimiter(text),
    }) as string[][];
    return toRows(grid.map(r => r.map(c => String(c ?? ''))));
  }

  const workbook = new ExcelJS.Workbook();
  // Buffer зі спільного пулу: передаємо копію саме нашого зрізу (див. XlsxService.toArrayBuffer).
  await workbook.xlsx.load(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  );
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const grid: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, row => {
    const cells: string[] = [];
    for (let c = 1; c <= Math.max(row.cellCount, DEFAULT_ORDER.length); c++) {
      cells.push(row.getCell(c).text ?? '');
    }
    grid.push(cells);
  });
  return toRows(grid);
}
