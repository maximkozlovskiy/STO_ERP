/**
 * Адреса для `<img src>`, яку задав користувач (логотип організації — вільний рядок у налаштуваннях)
 * або браузер (`URL.createObjectURL`). Пропускає лише `http(s):`, `blob:`, `data:image/…` і шлях
 * без схеми; решту (`javascript:`, `data:text/html`, `file:`…) — `null`, тоді картинки немає.
 *
 * `<img>` скриптів не виконує, але та сама адреса відкривається в лайтбоксі й може потрапити в
 * посилання: схема перевіряється в одному місці (CodeQL js/xss-through-dom).
 */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'blob:']);

export function safeImageSrc(src: string | null | undefined): string | null {
  if (!src) return null;
  const trimmed = src.trim();
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);/i.test(trimmed)) return trimmed;
  try {
    // База потрібна, щоб відносний шлях («/files/logo.png») розібрався без схеми сторінки.
    const url = new URL(trimmed, 'http://relative.invalid');
    return SAFE_PROTOCOLS.has(url.protocol) ? trimmed : null;
  } catch {
    return null;
  }
}
