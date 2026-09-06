/**
 * Логіка «scan-submit»: користувач у полі пошуку товару натискає Enter (сканер ШК
 * друкує цифри + Enter). Обираємо товар за таким пріоритетом:
 *   1. Точний збіг введеного зі ШК товару (головний `barcode` або будь-який із `barcodes[]`).
 *   2. Якщо точного немає, але результат РІВНО один — беремо його.
 *   3. Інакше (0 або кілька без точного матчу) — null (лишаємо список користувачу).
 *
 * Спільна для всіх точок додавання товару (SearchCombobox / GoodPickerModal /
 * SearchPickerModal / SupplierReturn inline). Чиста функція — легко тестувати.
 */
export interface ScannableGood {
  barcode?: string | null;
  barcodes?: string[] | null;
}

export function pickScannedGood<T extends ScannableGood>(items: T[], typed: string): T | null {
  const code = typed.trim();
  if (!code || items.length === 0) return null;

  // 1. Точний ШК-збіг (головний або додатковий).
  const exact = items.find(it => it.barcode === code || (it.barcodes?.includes(code) ?? false));
  if (exact) return exact;

  // 2. Єдиний результат → авто-вибір (напр. пошук за назвою дав один товар).
  if (items.length === 1) return items[0];

  // 3. Неоднозначно — не вгадуємо.
  return null;
}

/** Чи введене схоже на ШК (лише цифри, ≥8 символів) — для рішення робити exact-запит. */
export function looksLikeBarcode(typed: string): boolean {
  const t = typed.trim();
  return t.length >= 8 && /^\d+$/.test(t);
}
