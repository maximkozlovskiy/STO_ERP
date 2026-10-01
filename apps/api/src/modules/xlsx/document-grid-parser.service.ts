import { Injectable, BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { parse as parseCSV } from 'csv-parse/sync';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import {
  PdfNoTableError,
  PdfScannedError,
  PdfUnreadableError,
  fragmentsToGrid,
  pdfToGrid,
} from './pdf-grid.extractor';
import {
  OCR_PROVIDER,
  OcrModelsMissingError,
  OcrNoTextError,
  OcrTimeoutError,
  RasterizeUnavailableError,
} from './ocr-text-layer.provider';

/** Канал надходження накладної. Дзеркалить розширення файлу. */
export type GridSourceKind = 'xlsx' | 'csv' | 'pdf' | 'image';

/** Фото/скан. HEIC свідомо НЕ підтримуємо: його не читають ні tesseract, ні canvas. */
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'] as const;

/** Сітка + метадані джерела. rows — 0-based; номери колонок у мапінгу — 1-based. */
export interface ParsedGrid {
  rows: string[][];
  totalRows: number;
  columnCount: number;
  kind: GridSourceKind;
  /** Текст отримано розпізнаванням (а не з текстового шару/комірок) → UI попереджає про звірку. */
  ocr?: boolean;
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
    if (IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'image';
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
    // switch, а не тернарний ланцюжок: exhaustive-union дає помилку компіляції, якщо колись
    // додадуть канал і забудуть гілку.
    let rows: string[][];
    let ocr = false;
    switch (kind) {
      case 'csv':
        rows = this.parseCsvGrid(buffer);
        break;
      case 'pdf': {
        const res = await this.parsePdfGrid(buffer);
        rows = res.rows;
        ocr = res.ocr;
        break;
      }
      case 'image':
        rows = await this.parseImageGrid(buffer);
        ocr = true;
        break;
      case 'xlsx':
        rows = await this.parseXlsxGrid(buffer);
        break;
    }

    const columnCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
    return { rows, totalRows: rows.length, columnCount, kind, ocr };
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

  /**
   * PDF → сітка: спершу текстовий шар (точно, мілісекунди), і лише якщо його немає — OCR
   * растеризованої сторінки (приблизно, секунди). Повертає ще й ознаку, чи спрацював OCR.
   */
  private async parsePdfGrid(
    buffer: Buffer | Uint8Array,
  ): Promise<{ rows: string[][]; ocr: boolean }> {
    try {
      const res = await pdfToGrid(buffer);
      return { rows: res.rows, ocr: res.provider === 'ocr' };
    } catch (e) {
      throw this.toHttpError(e, 'pdf');
    }
  }

  /** Фото/скан → сітка через OCR. Растеризація не потрібна — байти вже растр. */
  private async parseImageGrid(buffer: Buffer | Uint8Array): Promise<string[][]> {
    try {
      const frags = await OCR_PROVIDER.extract(buffer);
      if (!frags?.length) {
        throw new BadRequestException(translateError('err.xlsx.ocrNoText', getLocale()));
      }
      return fragmentsToGrid(frags);
    } catch (e) {
      throw this.toHttpError(e, 'image');
    }
  }

  /** Технічні помилки парсерів → дружні 400 українською (а не сирі 500 зі стеком). */
  private toHttpError(e: unknown, channel: 'pdf' | 'image'): BadRequestException {
    if (e instanceof BadRequestException) return e;
    if (e instanceof OcrTimeoutError) {
      return new BadRequestException(translateError('err.xlsx.ocrTimeout', getLocale()));
    }
    if (e instanceof OcrModelsMissingError) {
      return new BadRequestException(translateError('err.xlsx.ocrModelsMissing', getLocale()));
    }
    if (e instanceof RasterizeUnavailableError) {
      return new BadRequestException(translateError('err.xlsx.pdfScanOcrUnavailable', getLocale()));
    }
    if (e instanceof PdfScannedError || e instanceof OcrNoTextError) {
      // І текстового шару немає, і OCR слів не знайшов.
      return new BadRequestException(translateError('err.xlsx.pdfNoTextLayer', getLocale()));
    }
    if (e instanceof PdfNoTableError) {
      return new BadRequestException(
        translateError(
          channel === 'image' ? 'err.xlsx.imageNoTableStructure' : 'err.xlsx.pdfNoTableStructure',
          getLocale(),
        ),
      );
    }
    if (e instanceof PdfUnreadableError) {
      return new BadRequestException(translateError('err.xlsx.pdfUnreadable', getLocale()));
    }
    return new BadRequestException(translateError('err.xlsx.fileReadFailed', getLocale()));
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
