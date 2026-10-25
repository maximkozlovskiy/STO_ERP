import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { getLocale } from '../tenant/tenant-context';
import { detectMimeFromBuffer, isDetectedZip } from './file-signature';

/**
 * BR-SEC-UPLOAD — захисні перевірки файлів імпорту (xlsx-майстер, банківські виписки).
 *
 * До 2026-10-25 точки імпорту брали `file.toBuffer()` і одразу віддавали парсеру, довіряючи
 * розширенню/`Content-Type` з клієнта і не обмежуючи ні розмір на вході, ні кількість рядків до
 * повного читання файла. Це три окремі діри:
 *   1) тип за розширенням — .txt/.exe під .xlsx доходив до ExcelJS і давав безіменну 500;
 *   2) розмір — глобальний ліміт 25 МБ надто щедрий для таблиці на кілька тисяч рядків, великий
 *      файл тягнувся в пам'ять цілком перед розбором;
 *   3) рядки — apply-DTO капить 1000, але парс прев'ю читав увесь файл (умисно роздутий .xlsx
 *      на мільйони рядків = DoS пам'яті) ще до будь-якого ліміту.
 *
 * Межі свідомо вужчі за глобальні: імпорт — це таблиця, а не медіа.
 */

/** Окремий ліміт розміру файла імпорту (5 МБ) — менший за глобальні 25 МБ для медіа. */
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;

/** Кап рядків на парсі — узгоджено з apply-DTO `@ArrayMaxSize(1000)`. */
export const MAX_IMPORT_ROWS = 1000;

export type ImportFileKind = 'xlsx' | 'sheet' | 'bank' | 'document';

/**
 * Дозволені розширення за видом ендпоінта:
 *  - `xlsx`      — лише .xlsx (xlsx-майстер каталогів: товари/бренди/…, позиції документів);
 *  - `sheet`     — .xlsx / .csv (розцінка за списком, резолв товарів правила);
 *  - `bank`      — .xlsx / .csv / .dbf (банківські виписки: ще й FoxPro-експорт dbf);
 *  - `document`  — .xlsx / .csv / .pdf / зображення (OCR-канал накладних — pdf/скан мають власний
 *                  розбір, тож тип магічними байтами тут НЕ обмежуємо; лишаємо розширення, а кап
 *                  розміру — лише для табличних форматів цього каналу).
 */
const ALLOWED_EXT: Record<ImportFileKind, readonly string[]> = {
  xlsx: ['xlsx'],
  sheet: ['xlsx', 'csv'],
  bank: ['xlsx', 'csv', 'dbf'],
  document: ['xlsx', 'csv', 'pdf', 'jpg', 'jpeg', 'png'],
};

function extOf(filename: string): string {
  return (filename.split('.').pop() ?? '').toLowerCase();
}

function badType(): never {
  throw new BadRequestException(translateError('err.file.typeMismatch', getLocale()));
}

/**
 * Валідація файла імпорту перед розбором: розмір → розширення → (для xlsx) магічні байти.
 * Повертає буфер без змін, щоб викликати inline: `const buf = assertImportFile(await f.toBuffer(), name)`.
 *
 * Для `tabular`/`document` магічні байти .xlsx теж звіряємо (zip-сигнатура), а .csv/.dbf/.pdf —
 * текст/бінарні формати без єдиної сигнатури, тож тут лише розширення + розмір; сам парсер далі
 * віддає дружній 400 на пошкодженому вмісті.
 */
export function assertImportFile(
  buffer: Buffer,
  filename: string,
  kind: ImportFileKind = 'bank',
): Buffer {
  const ext = extOf(filename);
  if (!ALLOWED_EXT[kind].includes(ext)) badType();

  // Ліміт 5 МБ — для табличних форматів (.xlsx/.csv/.dbf), де кілька тисяч рядків важать кілобайти.
  // OCR-канал (pdf/скан/фото у `document`) свідомо під глобальним 25 МБ: якісний скан накладної
  // легко > 5 МБ, а OCR ми тут не чіпаємо (рішення власника). Тож для pdf/зображення розмір не
  // ріжемо — лише розширення й (для .xlsx) сигнатуру.
  const sizeCapped = kind !== 'document' || ext === 'xlsx' || ext === 'csv';
  if (sizeCapped && buffer.length > MAX_IMPORT_FILE_BYTES) {
    throw new BadRequestException(translateError('err.file.importTooLarge', getLocale()));
  }

  // Магічні байти для xlsx: файл із розширенням .xlsx, але не zip-контейнером (перейменований
  // .txt/.exe), відсікаємо тут — інакше ExcelJS кидає сирий Error і 500/неінформативне 400.
  if (ext === 'xlsx') {
    if (!isDetectedZip(detectMimeFromBuffer(buffer))) badType();
  }
  return buffer;
}

/** Кап рядків на парсі: > `MAX_IMPORT_ROWS` → 400 tooManyRows. Викликати, щойно відомо totalRows. */
export function assertImportRowCount(totalRows: number): void {
  if (totalRows > MAX_IMPORT_ROWS) {
    throw new BadRequestException(translateError('err.file.tooManyRows', getLocale()));
  }
}

/**
 * Акцесори multipart form-полів (`file.fields` = `{ fieldname: { value } }`) для import-контролерів.
 * `num(k)` — ціле ≥ 1 або undefined; `str(k)` — trim-рядок (порожній, якщо поля немає). Спільне для
 * xlsx- і bank-імпорту (один і той самий блок дублювався в обох контролерах — jscpd клон).
 */
export function multipartFields(file: unknown): {
  num: (k: string) => number | undefined;
  str: (k: string) => string;
} {
  const fields = (file as { fields?: Record<string, { value?: unknown }> }).fields ?? {};
  return {
    num: (k: string): number | undefined => {
      const v = fields[k]?.value;
      if (v === undefined || v === null || v === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined;
    },
    str: (k: string): string => String(fields[k]?.value ?? '').trim(),
  };
}
