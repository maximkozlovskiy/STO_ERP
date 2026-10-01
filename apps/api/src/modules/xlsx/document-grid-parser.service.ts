import { Injectable, BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { parse as parseCSV } from 'csv-parse/sync';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import {
  PdfNoTableError,
  PdfScannedError,
  PdfUnreadableError,
  pdfToGrid,
} from './pdf-grid.extractor';

/** Канал надходження накладної. Дзеркалить розширення файлу. */
export type GridSourceKind = 'xlsx' | 'csv' | 'pdf';

/** Сітка + метадані джерела. rows — 0-based; номери колонок у мапінгу — 1-based. */
export interface ParsedGrid {
  rows: string[][];
  totalRows: number;
  columnCount: number;
  kind: GridSourceKind;
}

/**
 * Парсер файлу-накладної у СПІЛЬНЕ представлення — сітку `string[][]`, незалежну від формату.
 * Далі з нею однаково працюють і передперегляд, і мапінг колонок, і резолвінг товарів.
 *
 * Архітектура дзеркалить перевірений `BankStatementParserService` (модуль bank-statements):
 * диспатч за розширенням + одна сітка на всі канали. Різниця лише у наборі форматів:
 * там .csv/.xlsx/.dbf, тут .xlsx/.csv/.pdf.
 */
@Injectable()
export class DocumentGridParserService {
  /** Канал за розширенням; null → формат не підтримується. */
  detectKind(filename: string): GridSourceKind | null {
    const lower = (filename ?? '').toLowerCase();
    if (lower.endsWith('.xlsx')) return 'xlsx';
    if (lower.endsWith('.csv')) return 'csv';
    if (lower.endsWith('.pdf')) return 'pdf';
    return null;
  }

  assertSupported(filename: string): GridSourceKind {
    const kind = this.detectKind(filename);
    if (!kind) {
      throw new BadRequestException(translateError('err.xlsx.unsupportedFormat', getLocale()));
    }
    return kind;
  }

  /** Файл → сітка. Не-підтримуваний/нечитомий файл → дружній 400 українською. */
  async parseGrid(buffer: Buffer | Uint8Array, filename: string): Promise<ParsedGrid> {
    const kind = this.assertSupported(filename);
    const rows =
      kind === 'csv'
        ? this.parseCsvGrid(buffer)
        : kind === 'pdf'
          ? await this.parsePdfGrid(buffer)
          : await this.parseXlsxGrid(buffer);

    const columnCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
    return { rows, totalRows: rows.length, columnCount, kind };
  }

  // ─── Грід-білдери ───────────────────────────────────────────────────────────

  private parseCsvGrid(buffer: Buffer | Uint8Array): string[][] {
    const text = Buffer.from(buffer).toString('utf-8').replace(/^﻿/, ''); // strip BOM
    try {
      // columns:false → сира сітка; relax_column_count — накладні часто мають нерівні рядки
      // (підсумки, примітки), і падати через це не можна.
      return parseCSV(text, {
        columns: false,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
      }) as string[][];
    } catch {
      throw new BadRequestException(translateError('err.xlsx.fileReadFailed', getLocale()));
    }
  }

  private async parseXlsxGrid(buffer: Buffer | Uint8Array): Promise<string[][]> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(this.toArrayBuffer(buffer));
    } catch {
      // Не-xlsx/пошкоджений буфер → jszip кидає сирий Error («Can't find end of central
      // directory…») → 500 з англомовним стеком. Віддаємо дружній 400 (клас Bug #751).
      throw new BadRequestException(translateError('err.xlsx.fileReadFailed', getLocale()));
    }
    const sheet = workbook.worksheets[0];
    if (!sheet)
      throw new BadRequestException(translateError('err.xlsx.tableNotFound', getLocale()));

    const grid: string[][] = [];
    sheet.eachRow(row => {
      const values = row.values as unknown[]; // 1-based: [0] завжди порожній
      const maxCol = Math.max(0, values.length - 1);
      const cells: string[] = [];
      for (let c = 1; c <= maxCol; c++) cells.push(this.cellText(values[c]));
      grid.push(cells);
    });
    return grid;
  }

  /** PDF → сітка через текстовий шар. Скан/битий файл → дружній 400 із порадою. */
  private async parsePdfGrid(buffer: Buffer | Uint8Array): Promise<string[][]> {
    try {
      return await pdfToGrid(buffer);
    } catch (e) {
      if (e instanceof PdfScannedError) {
        // Коли з'явиться OCR-провайдер — pdfToGrid піде в нього і сюди вже не потрапить.
        throw new BadRequestException(translateError('err.xlsx.pdfNoTextLayer', getLocale()));
      }
      if (e instanceof PdfNoTableError) {
        throw new BadRequestException(translateError('err.xlsx.pdfNoTableStructure', getLocale()));
      }
      if (e instanceof PdfUnreadableError) {
        throw new BadRequestException(translateError('err.xlsx.pdfUnreadable', getLocale()));
      }
      throw new BadRequestException(translateError('err.xlsx.fileReadFailed', getLocale()));
    }
  }

  // ─── Хелпери ────────────────────────────────────────────────────────────────

  /**
   * Надійне текстове представлення комірки ExcelJS: rich-text, формули, гіперлінки, помилки, дати.
   * Прямий String(obj) дав би «[object Object]».
   */
  private cellText(v: unknown): string {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v instanceof Date) return v.toLocaleDateString('uk-UA');
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
      // Формула: result може бути примітивом АБО об'єктом ({error}, rich-text) → рекурсія.
      if ('result' in o && o.result != null) return this.cellText(o.result);
      if ('hyperlink' in o && o.hyperlink != null) return String(o.hyperlink).trim();
    }
    return String(v).trim();
  }

  /**
   * Buffer/Uint8Array → незалежний ArrayBuffer. Buffer.allocUnsafe бере пам'ять зі спільного пулу,
   * тож buffer.buffer може бути більший за дані з byteOffset > 0 — прямий cast дав би ExcelJS
   * чужі байти. slice гарантує копію саме нашого зрізу.
   */
  private toArrayBuffer(buf: Buffer | Uint8Array): ArrayBuffer {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }
}
