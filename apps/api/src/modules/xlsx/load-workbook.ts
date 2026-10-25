import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { assertImportRowCount } from '../../common/utils/import-file-guard';

/** 400 «файл не вдалося прочитати» — замість сирої помилки бібліотеки і 500 (Bug #833). */
export function tableFileUnreadable(): BadRequestException {
  return new BadRequestException(translateError('err.xlsx.tableFileUnreadable', getLocale()));
}

/**
 * Відкриває XLSX. Текстовий файл, картинка, порожній або пошкоджений файл із розширенням .xlsx
 * кидають у jszip сирий Error («Can't find end of central directory…») — це помилка файла
 * користувача, а не сервера.
 *
 * BR-SEC-UPLOAD: після завантаження — кап рядків на парсі. Усі xlsx-парсери каталогів і позицій
 * документів ідуть через цей вхід, тож перевірка тут покриває їх усі одним місцем. Файл із
 * кількістю рядків > ліміту відхиляється до будь-якого ітерування по комірках.
 */
export async function loadXlsxWorkbook(buffer: Buffer | Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    // Buffer зі спільного пулу: передаємо копію саме нашого зрізу.
    await workbook.xlsx.load(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    );
  } catch {
    throw tableFileUnreadable();
  }
  const maxRows = workbook.worksheets.reduce((m, ws) => Math.max(m, ws.actualRowCount), 0);
  assertImportRowCount(maxRows);
  return workbook;
}
