import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { parse as parseCSV } from 'csv-parse/sync';
import { DBFFile } from 'dbffile';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { roundMoney } from '../../common/utils/math';
import type { RawTx } from './bank-reconciliation.service';
import { BANK_IMPORT_DIRECTION_MODES, type BankImportDirectionMode } from './bank-statement.dto';

/** Мапінг колонок файлу виписки (1-based). Дзеркалить PreviewImportColumnMapping. */
export interface ColumnMapping {
  startRow: number;
  dateCol: number;
  amountCol: number;
  externalIdCol: number;
  payerNameCol?: number;
  payerIbanCol?: number;
  payerEdrpouCol?: number;
  purposeCol?: number;
  /** BR-BANK-018: як файл задає напрям рядка; без значення — `SIGN`. */
  directionMode?: BankImportDirectionMode;
  /** Окрема колонка суми списання (лише для `SIGN`): `amountCol` — надходження, ця — списання. */
  debitCol?: number;
}

/**
 * Значення multipart-поля `directionMode` → режим напряму. Порожнє → `SIGN` (типове);
 * невідоме → 400: мовчазний відступ до `SIGN` імпортував би файл списань як надходження.
 */
export function parseDirectionMode(value: unknown): BankImportDirectionMode {
  const v = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!v) return 'SIGN';
  const mode = BANK_IMPORT_DIRECTION_MODES.find(m => m === v);
  if (!mode) {
    throw new BadRequestException(translateError('err.bankStatement.invalidFile', getLocale()));
  }
  return mode;
}

/**
 * Парсинг файлів банківської виписки (.xlsx / .csv). Чистий сервіс без DI-залежностей.
 * rawPreview — сира сітка для UI column-mapping; parseRows — типізовані RawTx за мапінгом.
 */
@Injectable()
export class BankStatementParserService {
  /** Незалежний ArrayBuffer для ExcelJS (див. xlsx.service.toArrayBuffer — той самий pool-guard). */
  private toArrayBuffer(buf: Buffer | Uint8Array): ArrayBuffer {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }

  private isCsv(filename: string): boolean {
    return filename.toLowerCase().endsWith('.csv');
  }

  private isDbf(filename: string): boolean {
    return filename.toLowerCase().endsWith('.dbf');
  }

  private assertSupported(filename: string): void {
    const lower = filename.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.xlsx') && !lower.endsWith('.dbf')) {
      throw new BadRequestException(translateError('err.bankStatement.invalidFile', getLocale()));
    }
  }

  /**
   * Сира сітка перших ~50 рядків файлу для UI column-mapping (mapping-незалежна). Нічого не резолвить.
   * .csv — розбір як текст; .xlsx — ExcelJS. Не-підтримуваний/битий файл → дружній 400.
   */
  async rawPreview(
    buffer: Buffer | Uint8Array,
    filename: string,
    limit = 50,
  ): Promise<{ totalRows: number; columnCount: number; rows: string[][] }> {
    this.assertSupported(filename);
    const cap = Math.min(Math.max(Math.trunc(limit) || 50, 1), 100);

    if (this.isCsv(filename)) {
      const grid = this.parseCsvGrid(buffer);
      const rows = grid.slice(0, cap);
      const columnCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
      return { totalRows: grid.length, columnCount, rows };
    }

    if (this.isDbf(filename)) {
      const grid = await this.parseDbfGrid(buffer);
      const rows = grid.slice(0, cap);
      const columnCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
      return { totalRows: grid.length, columnCount, rows };
    }

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(this.toArrayBuffer(buffer));
    } catch {
      throw new BadRequestException(
        translateError('err.bankStatement.fileReadFailed', getLocale()),
      );
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) {
      throw new BadRequestException(
        translateError('err.bankStatement.fileReadFailed', getLocale()),
      );
    }
    const rows: string[][] = [];
    let columnCount = 0;
    sheet.eachRow(row => {
      if (rows.length >= cap) return;
      const values = row.values as unknown[]; // 1-based: [0] порожній
      const maxCol = Math.max(0, values.length - 1);
      if (maxCol > columnCount) columnCount = maxCol;
      const cells: string[] = [];
      for (let c = 1; c <= maxCol; c++) cells.push(this.cellText(values[c]));
      rows.push(cells);
    });
    return { totalRows: sheet.actualRowCount, columnCount, rows };
  }

  /**
   * Типізовані транзакції за мапінгом колонок. startRow — рядок першої транзакції (1-based).
   * Порожні рядки (без дати, суми і externalId) пропускаються. Не-підтримуваний файл → 400.
   */
  async parseRows(
    buffer: Buffer | Uint8Array,
    filename: string,
    mapping: ColumnMapping,
  ): Promise<RawTx[]> {
    this.assertSupported(filename);
    const grid = this.isCsv(filename)
      ? this.parseCsvGrid(buffer)
      : this.isDbf(filename)
        ? await this.parseDbfGrid(buffer)
        : await this.parseXlsxGrid(buffer);

    const startRow = mapping.startRow && mapping.startRow >= 1 ? mapping.startRow : 1;
    const mode = mapping.directionMode ?? 'SIGN';
    // Дві колонки сум мають сенс лише в SIGN: IN / OUT оголошують увесь файл одним напрямом.
    const splitColumns = mode === 'SIGN' && !!mapping.debitCol && mapping.debitCol >= 1;
    const rows: RawTx[] = [];
    // grid — 0-based масив; колонки мапінгу — 1-based. rowNo (1-based) для порівняння зі startRow.
    for (let i = 0; i < grid.length; i++) {
      const rowNo = i + 1;
      if (rowNo < startRow) continue;
      const cells = grid[i];
      const cell = (col?: number): string => (col && col >= 1 ? (cells[col - 1] ?? '').trim() : '');

      const externalId = cell(mapping.externalIdCol);
      const rawDate = cell(mapping.dateCol);
      const rawAmount = cell(mapping.amountCol);
      const rawDebit = splitColumns ? cell(mapping.debitCol) : '';
      // Порожній рядок (усі ключові поля порожні) — пропускаємо.
      if (!externalId && !rawDate && !rawAmount && !rawDebit) continue;

      const money = this.resolveAmount(mode, splitColumns, rawAmount, rawDebit);
      const operationDate = this.parseDate(rawDate);
      // Рядок без валідної суми/дати/id — пропускаємо (заголовок-повторення, підсумковий рядок).
      if (!money || !operationDate || !externalId) continue;

      const iban = cell(mapping.payerIbanCol);
      rows.push({
        externalId,
        operationDate,
        direction: money.direction,
        amount: money.amount,
        payerName: cell(mapping.payerNameCol) || null,
        payerIban: iban ? iban.toUpperCase().replace(/\s+/g, '') : null,
        payerEdrpou: cell(mapping.payerEdrpouCol) || null,
        purpose: cell(mapping.purposeCol) || null,
        rawData: { row: cells },
      });
    }

    if (rows.length === 0) {
      throw new BadRequestException(translateError('err.bankStatement.noDataRows', getLocale()));
    }
    return rows;
  }

  // ─── Внутрішні хелпери ──────────────────────────────────────────────────────

  /**
   * BR-BANK-017 / 018: сума рядка (завжди > 0) і його напрям; `null` — рядок пропускається.
   *  - SIGN, одна колонка: від'ємна сума → OUT, у базу йде модуль;
   *  - SIGN, дві колонки: `amountCol` — надходження, `debitCol` — списання; сума рівно в одній
   *    (обидві ненульові або обидві порожні → пропуск: напрям такого рядка невизначений);
   *  - IN / OUT: увесь файл одного напряму, знак ігнорується.
   * Нульова чи нерозбірна сума → пропуск.
   */
  private resolveAmount(
    mode: BankImportDirectionMode,
    splitColumns: boolean,
    rawAmount: string,
    rawDebit: string,
  ): { amount: number; direction: 'IN' | 'OUT' } | null {
    // Сума рядка — у копійках: колонка `Decimal(12,2)`, а `import/apply` відхиляє суму < 0.01
    // (один рядок «-0,005» або float-хвіст Excel «0.30000000000000004» блокував увесь імпорт).
    // Те, що округлюється до нуля, — нульовий рядок (BR-BANK-017).
    const cents = (raw: string): number => roundMoney(Math.abs(this.parseNumber(raw) ?? 0));
    if (splitColumns) {
      const credit = cents(rawAmount);
      const debit = cents(rawDebit);
      if (credit > 0 === debit > 0) return null;
      return credit > 0 ? { amount: credit, direction: 'IN' } : { amount: debit, direction: 'OUT' };
    }
    const signed = this.parseNumber(rawAmount);
    const amount = cents(rawAmount);
    if (signed == null || amount === 0) return null;
    const direction = mode === 'SIGN' ? (signed < 0 ? 'OUT' : 'IN') : mode;
    return { amount, direction };
  }

  /**
   * Роздільник колонок CSV: `,`, `;` або табуляція — той, якого більше поза лапками в перших
   * рядках файла. Українські банки й Excel з українською локаллю розділяють колонки `;` (кома
   * зайнята копійками); за рівності — `,` (типовий для csv-parse).
   */
  private detectCsvDelimiter(text: string): string {
    const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
    const lines = text
      .split(/\r?\n/)
      .filter(l => l.trim().length > 0)
      .slice(0, 20);
    for (const line of lines) {
      let inQuotes = false;
      for (const ch of line) {
        if (ch === '"') inQuotes = !inQuotes;
        else if (!inQuotes && ch in counts) counts[ch]++;
      }
    }
    if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
    if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t';
    return ',';
  }

  private parseCsvGrid(buffer: Buffer | Uint8Array): string[][] {
    const text = Buffer.from(buffer).toString('utf-8').replace(/^﻿/, ''); // strip BOM
    try {
      // relax_column_count — банки часто мають нерівні рядки; columns:false → сира сітка.
      const records = parseCSV(text, {
        columns: false,
        delimiter: this.detectCsvDelimiter(text),
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
      });
      return records;
    } catch {
      throw new BadRequestException(
        translateError('err.bankStatement.fileReadFailed', getLocale()),
      );
    }
  }

  private async parseXlsxGrid(buffer: Buffer | Uint8Array): Promise<string[][]> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(this.toArrayBuffer(buffer));
    } catch {
      throw new BadRequestException(
        translateError('err.bankStatement.fileReadFailed', getLocale()),
      );
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) {
      throw new BadRequestException(
        translateError('err.bankStatement.fileReadFailed', getLocale()),
      );
    }
    // Матеріалізуємо у 0-based сітку з абсолютною нумерацією рядків (порожні провідні → порожні рядки),
    // щоб startRow-семантика збігалась із UI-передпереглядом (rawPreview показує ті самі рядки).
    const grid: string[][] = [];
    sheet.eachRow((row, rowNumber) => {
      const values = row.values as unknown[]; // 1-based
      const maxCol = Math.max(0, values.length - 1);
      const cells: string[] = [];
      for (let c = 1; c <= maxCol; c++) cells.push(this.cellText(values[c]));
      // rowNumber 1-based → індекс rowNumber-1; заповнюємо пропуски порожніми рядками.
      while (grid.length < rowNumber - 1) grid.push([]);
      grid[rowNumber - 1] = cells;
    });
    return grid;
  }

  /**
   * DBF (dBASE) → 0-based сітка string[][]: рядок[0] = назви полів (header для UI column-mapping),
   * решта рядків = значення записів. dbffile (pure-JS, offline, без нативних біндингів) читає лише
   * з шляху файлу → пишемо buffer у temp-файл, читаємо, прибираємо. Дати (D-поля) → DD.MM.YYYY
   * (через cellText — parseDate розбере назад), числа → String.
   *
   * MANUAL-VERIFY (на живих файлах Ощад/Райф/ПУМБ): encoding — win1251 дефолт (повний укр. набір
   * і/ї/є/ґ, який cp866 НЕ має; тому win1251 безпечніший для укр. банків). Якщо кирилиця у назвах
   * полів/значеннях б'ється — деякі старі FoxPro-експорти йдуть у cp866 (OEM): тоді cp866 fallback.
   */
  private async parseDbfGrid(buffer: Buffer | Uint8Array): Promise<string[][]> {
    // dbffile.open читає з ФС → тимчасовий файл (offline, локальний ПК/сервер СТО).
    let dir: string | null = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'sto-dbf-'));
      const filePath = join(dir, `${randomUUID()}.dbf`);
      await writeFile(filePath, Buffer.from(buffer));
      // readMode:'loose' — не падати на невідомих версіях/типах полів (memo тощо); encoding win1251.
      const dbf = await DBFFile.open(filePath, { readMode: 'loose', encoding: 'win1251' });
      const fieldNames = dbf.fields.map(f => f.name);
      const grid: string[][] = [fieldNames];
      const records = await dbf.readRecords();
      for (const rec of records) {
        grid.push(fieldNames.map(name => this.cellText((rec as Record<string, unknown>)[name])));
      }
      return grid;
    } catch {
      throw new BadRequestException(
        translateError('err.bankStatement.fileReadFailed', getLocale()),
      );
    } finally {
      // Прибираємо temp-директорію (best-effort — не валимо парсинг на помилці cleanup).
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Текстове представлення комірки ExcelJS (rich-text/формула/дата/гіперлінк). Див. xlsx.service. */
  private cellText(v: unknown): string {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v instanceof Date) {
      // ExcelJS дату-комірку віддає Date — форматуємо як DD.MM.YYYY (UA), parseDate розбере назад.
      const d = v;
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      return `${dd}.${mm}.${d.getUTCFullYear()}`;
    }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (Array.isArray(o.richText)) {
        return o.richText
          .map(rt => String((rt as { text?: unknown }).text ?? ''))
          .join('')
          .trim();
      }
      if ('text' in o && o.text != null) return String(o.text).trim();
      if ('error' in o && o.error != null) return String(o.error);
      if ('result' in o && o.result != null) return this.cellText(o.result);
      if ('hyperlink' in o && o.hyperlink != null) return String(o.hyperlink).trim();
    }
    return String(v).trim();
  }

  /**
   * Сума з виписки → число зі знаком. Порожнє / нерозбірне → null (рядок пропускається).
   * Формати, які справді трапляються в експортах банків і Excel:
   *  - «1 250,00» / «1250.00» — пробіли (звичайні й нерозривні) як роздільники тисяч;
   *  - «(150,00)» — бухгалтерський запис від'ємної суми; «−200,00» — типографський мінус (U+2212);
   *  - «150,00 грн» / «₴150» / «150.00 UAH» — позначка валюти до чи після числа;
   *  - «1.234,56» / «1,234.56» — обидва роздільники: ОСТАННІЙ із них десятковий, інший — тисячі;
   *    кілька однакових без іншого («1,234,567») — тисячі.
   * Одна кома чи одна крапка — десятковий роздільник («1,234» = 1.234, а не 1234).
   */
  private parseNumber(value: string): number | null {
    if (!value) return null;
    let s = value.replace(/\s+/g, '').replace(/[−‒–—]/g, '-');
    const bracketed = /^\((.+)\)$/.exec(s);
    if (bracketed) s = bracketed[1];
    s = s.replace(/^[₴$€£]/, '').replace(/(?:грн\.?|[a-zа-яіїєґ]{3}|[₴$€£])$/i, '');
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma >= 0 && lastDot >= 0) {
      const [decimal, thousands] = lastComma > lastDot ? [',', '.'] : ['.', ','];
      s = s.split(thousands).join('').replace(decimal, '.');
    } else if (lastComma >= 0) {
      s = s.indexOf(',') === lastComma ? s.replace(',', '.') : s.split(',').join('');
    } else if (lastDot >= 0 && s.indexOf('.') !== lastDot) {
      s = s.split('.').join('');
    }
    if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(s)) return null;
    const num = Number(s);
    if (!Number.isFinite(num)) return null;
    return bracketed ? -Math.abs(num) : num;
  }

  /**
   * Дата: спершу DD.MM.YYYY (формат Privat24 / більшості укр. банків), потім ISO fallback.
   * Повертає UTC-північ (@db.Date-сумісно). Невалідне → null.
   */
  private parseDate(value: string): Date | null {
    if (!value) return null;
    const v = value.trim();
    // DD.MM.YYYY (опційно з часом після пробілу — беремо лише дату).
    const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(v);
    if (m) {
      const dd = Number(m[1]);
      const mm = Number(m[2]);
      const yyyy = Number(m[3]);
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        const d = new Date(Date.UTC(yyyy, mm - 1, dd));
        // Відхиляємо неіснуючі дати (31.02, 31.04): JS Date «перекочує» їх у наступний місяць
        // (31.02 → 03.03), що тихо зіпсувало б operationDate реальної банк-транзакції (а вона
        // визначає курс для amountBase). Звіряємо компоненти з побудованою датою → нема rollover.
        if (d.getUTCFullYear() !== yyyy || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) {
          return null;
        }
        return Number.isNaN(d.getTime()) ? null : d;
      }
      return null;
    }
    // ISO fallback (YYYY-MM-DD або повний ISO) — нормалізуємо до UTC-півночі за date-частиною.
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    if (iso) {
      const yyyy = Number(iso[1]);
      const mm = Number(iso[2]);
      const dd = Number(iso[3]);
      const d = new Date(Date.UTC(yyyy, mm - 1, dd));
      // Той самий rollover-guard, що й для DD.MM.YYYY: JS «перекочує» неіснуючі ISO-дати
      // (2024-02-31 → 03-02, невисокосний 2023-02-29 → 03-01), що тихо зіпсувало б operationDate
      // (а вона визначає курс для amountBase). Звіряємо компоненти → нема rollover.
      if (d.getUTCFullYear() !== yyyy || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) {
        return null;
      }
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  }
}
