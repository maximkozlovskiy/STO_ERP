import { tableFileUnreadable } from './load-workbook';

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
/** Скільки байтів з початку дивитись на ознаки двійкового файла. */
const BINARY_SNIFF_BYTES = 4096;

/**
 * Текстовий табличний файл (CSV) → рядок. Кодування визначається за вмістом:
 *  · BOM UTF-8 або коректний UTF-8 → UTF-8;
 *  · байти, що не складаються в UTF-8, → Windows-1251 (так зберігає CSV Excel у
 *    кириличній локалі Windows: кирилиця 0xC0–0xFF у UTF-8 майже ніколи не буває валідною).
 * Двійковий вміст (архів XLSX із розширенням .csv, NUL-байти) → 400 «не вдалося прочитати»:
 * у Windows-1251 будь-які байти «декодуються», і замість помилки вийшла б сміттєва таблиця.
 */
export function decodeTextFile(bytes: Buffer | Uint8Array): string {
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw tableFileUnreadable();

  // BOM — явна заява «це UTF-8»: окремий битий байт стає «�», а не перемикає весь файл.
  if (UTF8_BOM.every((b, i) => bytes[i] === b)) {
    return new TextDecoder('utf-8').decode(bytes.subarray(UTF8_BOM.length));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}
