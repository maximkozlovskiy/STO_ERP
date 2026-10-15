// Спільний helper браузерного завантаження Blob/URL і друку PDF (single source of truth).
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

/** Скільки живе blob-URL друкованого PDF, якщо вікно перегляду не повідомило про закриття. */
const PRINT_URL_TTL_MS = 10 * 60 * 1000;

/**
 * Відкрити PDF із сервера для друку: нове вікно з документом і одразу діалог друку
 * (у переглядачі PDF лишаються «Зберегти» й повторний друк).
 *
 * ВИКЛИКАТИ ПЕРШИМ у обробнику кліку, ДО будь-якого `await`: вікно відкривається синхронно,
 * поки триває жест користувача, — після await браузер блокує `window.open` як спливаюче вікно.
 * Тому вікно відкривається порожнім ще до запиту, а PDF підставляється, коли прийде.
 *
 * Запит упав → вікно закривається, помилка летить далі (показує той, хто кликав).
 * Спливаюче вікно все одно заблоковано → друк через приховану рамку в цій сторінці.
 */
export async function printPdf(load: () => Promise<Blob>, title = 'PDF'): Promise<void> {
  const win = window.open('', '_blank');
  let blob: Blob;
  try {
    blob = await load();
  } catch (e) {
    win?.close();
    throw e;
  }
  const pdf =
    blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
  const url = URL.createObjectURL(pdf);
  const revoke = () => URL.revokeObjectURL(url);
  setTimeout(revoke, PRINT_URL_TTL_MS);

  if (!win || win.closed) {
    printInFrame(document, url, { hidden: true, onDone: revoke });
    return;
  }
  const doc = win.document;
  doc.title = title;
  doc.body.style.margin = '0';
  win.addEventListener('pagehide', revoke, { once: true });
  printInFrame(doc, url, { hidden: false });
}

/** PDF у рамці документа `doc` і виклик друку, щойно рамка завантажилась. */
function printInFrame(
  doc: Document,
  url: string,
  { hidden, onDone }: { hidden: boolean; onDone?: () => void },
): void {
  const frame = doc.createElement('iframe');
  frame.style.cssText = hidden
    ? 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0'
    : 'display:block;width:100vw;height:100vh;border:0';
  frame.addEventListener(
    'load',
    () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        // Переглядач PDF не дав викликати друк — у ньому є власна кнопка друку.
      }
      if (hidden)
        setTimeout(() => {
          frame.remove();
          onDone?.();
        }, PRINT_URL_TTL_MS);
    },
    { once: true },
  );
  frame.src = url;
  doc.body.appendChild(frame);
}
