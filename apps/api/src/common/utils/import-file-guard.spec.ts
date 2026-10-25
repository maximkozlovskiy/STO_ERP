import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  assertImportFile,
  assertImportRowCount,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_ROWS,
  type ImportFileKind,
} from './import-file-guard';

/**
 * BR-SEC-UPLOAD: гарди файлів імпорту — розмір / розширення / магічні байти / кап рядків.
 * Повідомлення звіряємо з українськими ключами (`err.file.*`) — доводить, що саме цей клас помилки
 * повертається, а не загальна 400.
 * Мутації: прибрати перевірку розміру → кейс «завеликий» зелений; прибрати перевірку сигнатури
 * .xlsx → кейс «.txt під .xlsx» зелений; прибрати кап рядків → кейс «> MAX_IMPORT_ROWS» зелений.
 */

const ZIP_HEAD = [0x50, 0x4b, 0x03, 0x04];
const xlsxBuf = (tail = 64) => Buffer.concat([Buffer.from(ZIP_HEAD), Buffer.alloc(tail, 0x00)]);
const txtBuf = () => Buffer.from('name;price\nшина;100', 'utf-8');

const errOf = (fn: () => unknown): BadRequestException => {
  try {
    fn();
  } catch (e) {
    if (e instanceof BadRequestException) return e;
    throw e;
  }
  throw new Error('очікували BadRequestException');
};

describe('assertImportFile — розширення', () => {
  it.each<[ImportFileKind, string, boolean]>([
    ['xlsx', 'goods.xlsx', true],
    ['xlsx', 'goods.csv', false],
    ['xlsx', 'goods.txt', false],
    ['sheet', 'list.csv', true],
    ['sheet', 'list.xlsx', true],
    ['sheet', 'list.dbf', false],
    ['bank', 'statement.dbf', true],
    ['bank', 'statement.pdf', false],
    ['document', 'invoice.pdf', true],
    ['document', 'invoice.jpg', true],
    ['document', 'invoice.exe', false],
  ])('kind=%s файл=%s дозволено=%s', (kind, filename, allowed) => {
    // для .xlsx підкладаємо валідну zip-сигнатуру, щоб перевіряти саме розширення
    const buf = filename.endsWith('.xlsx') ? xlsxBuf() : Buffer.from('any-small-content');
    if (allowed) {
      expect(() => assertImportFile(buf, filename, kind)).not.toThrow();
    } else {
      expect(errOf(() => assertImportFile(buf, filename, kind)).message).toBe(
        'Вміст файлу не відповідає його розширенню',
      );
    }
  });
});

describe('assertImportFile — магічні байти .xlsx', () => {
  it('.xlsx з валідною zip-сигнатурою проходить', () => {
    expect(() => assertImportFile(xlsxBuf(), 'goods.xlsx', 'xlsx')).not.toThrow();
  });

  it('.txt/.exe перейменований у .xlsx → 400 typeMismatch', () => {
    expect(errOf(() => assertImportFile(txtBuf(), 'goods.xlsx', 'xlsx')).message).toBe(
      'Вміст файлу не відповідає його розширенню',
    );
    const mz = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x00, 0x00]);
    expect(() => assertImportFile(mz, 'goods.xlsx', 'xlsx')).toThrow(BadRequestException);
  });

  it('.csv не вимагає zip-сигнатури (текст проходить)', () => {
    expect(() => assertImportFile(txtBuf(), 'list.csv', 'sheet')).not.toThrow();
  });
});

describe('assertImportFile — розмір', () => {
  it('файл > MAX_IMPORT_FILE_BYTES → 400 importTooLarge', () => {
    const big = xlsxBuf(MAX_IMPORT_FILE_BYTES + 1);
    expect(errOf(() => assertImportFile(big, 'goods.xlsx', 'xlsx')).message).toBe(
      'Файл для імпорту завеликий',
    );
  });

  it('OCR-канал (pdf/зображення у document) НЕ ріжеться 5 МБ', () => {
    const bigPdf = Buffer.concat([
      Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
      Buffer.alloc(MAX_IMPORT_FILE_BYTES + 100, 0x20),
    ]);
    expect(() => assertImportFile(bigPdf, 'scan.pdf', 'document')).not.toThrow();
  });

  it('табличний у document-каналі (.xlsx/.csv) — ріжеться 5 МБ', () => {
    const bigXlsx = xlsxBuf(MAX_IMPORT_FILE_BYTES + 1);
    expect(() => assertImportFile(bigXlsx, 'rows.xlsx', 'document')).toThrow(BadRequestException);
  });
});

describe('assertImportRowCount', () => {
  it('у межах ліміту — не кидає', () => {
    expect(() => assertImportRowCount(MAX_IMPORT_ROWS)).not.toThrow();
    expect(() => assertImportRowCount(0)).not.toThrow();
  });

  it('> MAX_IMPORT_ROWS → 400 tooManyRows', () => {
    expect(errOf(() => assertImportRowCount(MAX_IMPORT_ROWS + 1)).message).toBe(
      'Забагато рядків у файлі для імпорту',
    );
  });
});
