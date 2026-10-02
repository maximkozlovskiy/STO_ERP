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
import type { RawTx } from './bank-reconciliation.service';

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
      // Порожній рядок (усі три ключові поля порожні) — пропускаємо.
      if (!externalId && !rawDate && !rawAmount) continue;

      const amount = this.parseNumber(rawAmount);
      const operationDate = this.parseDate(rawDate);
      // Рядок без валідної суми/дати/id — пропускаємо (заголовок-повторення, підсумковий рядок).
      if (amount == null || !operationDate || !externalId) continue;

      const iban = cell(mapping.payerIbanCol);
      rows.push({
        externalId,
        operationDate,
        amount,
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

  private parseCsvGrid(buffer: Buffer | Uint8Array): string[][] {
    const text = Buffer.from(buffer).toString('utf-8').replace(/^﻿/, ''); // strip BOM
    try {
      // relax_column_count — банки часто мають нерівні рядки; columns:false → сира сітка.
      const records = parseCSV(text, {
        columns: false,
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
   * Число з UA-локалі: кома як десятковий роздільник, пробіли-роздільники тисяч. Дзеркалить
   * xlsx.service.parseNumber. Знак «+»/«-» зберігається. Порожнє/невалідне → null.
   */
  private parseNumber(value: string): number | null {
    if (!value) return null;
    const trimmed = value.trim().replace(/\s+/g, '');
    // Лише кома як десятковий («1250,00»→«1250.00»); mixed «1.234,56» — не вгадуємо → NaN → null.
    const normalized =
      trimmed.includes(',') && !trimmed.includes('.') ? trimmed.replace(',', '.') : trimmed;
    const num = Number(normalized);
    return Number.isFinite(num) ? num : null;
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
