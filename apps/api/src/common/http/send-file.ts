import type { FastifyReply } from 'fastify';

/** Символи, заборонені в імені файла Windows, — у номері документа замінюються на `-`. */
const UNSAFE_FILENAME_CHARS = /[/\\:*?"<>|]/g;

/** Номер документа, придатний для імені файла (`INV/2026/1` → `INV-2026-1`). */
export function safeFilenamePart(s: string): string {
  return s.replace(UNSAFE_FILENAME_CHARS, '-');
}

/**
 * `Content-Disposition` вкладення з ім'ям кирилицею (RFC 6266 / RFC 5987): `filename*=UTF-8''…`.
 * `encodeURIComponent` лишає `'()*!` — за RFC 5987 у ext-value їх теж кодуємо (апостроф інакше
 * обриває значення у суворих розбирачах).
 */
export function attachmentDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}

/** Віддати файл вкладенням: тип, ім'я (кирилиця) і довжина. */
export function sendFile(
  reply: FastifyReply,
  buffer: Buffer,
  filename: string,
  contentType: string,
): void {
  void reply
    .header('Content-Type', contentType)
    .header('Content-Disposition', attachmentDisposition(filename))
    .header('Content-Length', buffer.length)
    .send(buffer);
}
