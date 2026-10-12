import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';

/** 400 «файл не вдалося прочитати» — замість сирої помилки бібліотеки і 500 (Bug #833). */
export function tableFileUnreadable(): BadRequestException {
  return new BadRequestException(translateError('err.xlsx.tableFileUnreadable', getLocale()));
}

/**
 * Відкриває XLSX. Текстовий файл, картинка, порожній або пошкоджений файл із розширенням .xlsx
 * кидають у jszip сирий Error («Can't find end of central directory…») — це помилка файла
 * користувача, а не сервера.
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
  return workbook;
}
