// Календар не тримає записи в кеші TanStack Query: вид «День»/«Місяць» читає `GET /calendar/slots`
// сам (useCalendarState). Наряд із плановими датами змінює свій запис календаря на сервері
// (BR-WO-020), тож після збереження наряду відкритий календар має перечитати записи — інакше
// показує запис на старому місці. Подія на window: картка наряду відкривається поверх будь-якої
// сторінки (вкладки, форма запису календаря), і прямого посилання на стан календаря в неї немає.

const EVENT = 'sto:calendar-changed';

/** Записи календаря змінились на сервері — відкритий календар перечитує їх. */
export function notifyCalendarChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Підписка календаря; повертає відписку (для cleanup ефекту). */
export function onCalendarChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
