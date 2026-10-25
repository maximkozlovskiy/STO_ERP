/**
 * Визначення типу файлу за першими байтами (magic number), а не за заявленим клієнтом
 * `Content-Type` чи розширенням. Заявлений тип підробити тривіально (перейменувати .exe → .png,
 * виставити `image/png` у multipart-частині), і сервер, що йому довіряє, зберігає й роздає
 * довільний вміст під виглядом зображення. Сигнатура в байтах файла — те, що не підробити
 * перейменуванням.
 *
 * Повертає КАНОНІЧНИЙ mime або `null`, якщо жодна відома сигнатура не збіглася. Викликач сам
 * вирішує, які типи дозволені (image/* для фото, zip для xlsx тощо).
 */

/** Канонічні mime-типи, які вміємо впізнати за байтами. */
export type DetectedMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'
  | 'image/heic'
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** XLSX — це ZIP-архів (OOXML): той самий `PK\x03\x04`, що й .zip/.docx/.pptx. */
export const ZIP_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;

/** Байт на позиції `i` дорівнює очікуваному (з guard на вихід за межі буфера). */
function at(buf: Buffer, i: number, byte: number): boolean {
  return i < buf.length && buf[i] === byte;
}

/** Послідовність байтів від зсуву `offset` збігається з `bytes`. */
function startsWith(buf: Buffer, bytes: readonly number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
}

/**
 * Тип файлу за сигнатурою перших байтів. `null` — сигнатура невідома (включно з порожнім
 * буфером і текстом/`MZ`-виконуваним файлом, які саме треба відсікати).
 *
 * Розпізнаємо:
 *  - PNG   — `89 50 4E 47 0D 0A 1A 0A`
 *  - JPEG  — `FF D8 FF`
 *  - WEBP  — `RIFF`…`WEBP` (`52 49 46 46` на 0, `57 45 42 50` на 8)
 *  - PDF   — `%PDF-` (`25 50 44 46 2D`)
 *  - ZIP   — `PK\x03\x04` (XLSX/DOCX/… — OOXML-контейнер); також порожній (`PK\x05\x06`) і
 *            spanned (`PK\x07\x08`) заголовки ZIP, які трапляються в легітимних архівах.
 */
export function detectMimeFromBuffer(buffer: Buffer | Uint8Array): DetectedMime | null {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 4) return null;

  // PNG
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // JPEG (JFIF/EXIF — усі починаються з FF D8 FF)
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // GIF (GIF87a / GIF89a)
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  // PDF
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  // WEBP: контейнер RIFF, тип WEBP на зсуві 8
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  // HEIC/HEIF: ISO-BMFF `ftyp`-box на зсуві 4 (`66 74 79 70`) з brand heic/heix/mif1/heif/hevc.
  // Камери iPhone знімають у HEIC; web приймає image/* → файл реально долітає сюди.
  if (startsWith(buf, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (['heic', 'heix', 'mif1', 'heif', 'hevc', 'msf1'].includes(brand)) return 'image/heic';
  }
  // ZIP/OOXML: `PK` + (03 04 | 05 06 | 07 08)
  if (
    at(buf, 0, 0x50) &&
    at(buf, 1, 0x4b) &&
    ((at(buf, 2, 0x03) && at(buf, 3, 0x04)) ||
      (at(buf, 2, 0x05) && at(buf, 3, 0x06)) ||
      (at(buf, 2, 0x07) && at(buf, 3, 0x08)))
  ) {
    return ZIP_MIME;
  }

  return null;
}

/** Впізнаний тип — зображення (PNG/JPEG/WEBP/GIF/HEIC). */
export function isDetectedImage(mime: DetectedMime | null): boolean {
  return (
    mime === 'image/png' ||
    mime === 'image/jpeg' ||
    mime === 'image/webp' ||
    mime === 'image/gif' ||
    mime === 'image/heic'
  );
}

/** Впізнаний тип — ZIP-контейнер (XLSX і споріднені OOXML). */
export function isDetectedZip(mime: DetectedMime | null): boolean {
  return mime === ZIP_MIME;
}
