// Спільний helper браузерного завантаження Blob/URL (single source of truth).
// Причина існування: appendChild/removeChild навколо a.click() ОБОВ'ЯЗКОВІ — Firefox/Safari
// НЕ диспатчать click на detached anchor (тиха відмова завантаження); revokeObjectURL мусить
// бути ВІДКЛАДЕНИМ (Chromium дропає завантаження при негайному revoke). Раніше цей блок
// копіювався inline по 9+ сайтах — кожна нова копія ризикувала знову загубити appendChild.

/** Завантажити Blob як файл. Гарантує attached-anchor + відкладений revoke. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    downloadUrl(url, filename);
  } finally {
    // Відкладений revoke: негайний ламає завантаження у Chromium.
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }
}

/**
 * Завантажити файл за URL (blob:, data: або звичайний). НЕ робить revoke — для blob-URL
 * використовуй downloadBlob(), який керує життєвим циклом об'єктного URL сам.
 */
export function downloadUrl(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // appendChild/removeChild: Firefox/Safari не диспатчать click на detached anchor.
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
