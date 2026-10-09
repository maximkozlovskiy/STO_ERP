/**
 * Текст пошуку → буквальний рядок для Prisma `contains` / `startsWith` / `endsWith`.
 *
 * Prisma на PostgreSQL будує `ILIKE ('%' || $1 || '%')` і значення НЕ екранує (перевірено на
 * dev-базі 2026-10-09: `contains: '%'` і `contains: '_'` повертали всі рядки таблиці). Тому `%`
 * і `_` у тексті користувача працюють як символи підстановки: пошук «100%» знаходить усе, що
 * містить «100», а артикул «AB_12» — ще й «ABX12». Зворотна коса — символ екранування за
 * замовчуванням, тож і її подвоюємо.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/** Найбільша довжина тексту пошуку у списках документів: довше — обрізається (або 400 у DTO). */
export const LIST_SEARCH_MAX_LENGTH = 100;

/**
 * Текст пошуку зі списку → умова Prisma «містить, без урахування регістру» з буквальними
 * `%` / `_`. Порожній або з самих пробілів → `undefined` (умову в `where` не додають).
 */
export function searchContains(q?: string): { contains: string; mode: 'insensitive' } | undefined {
  const search = q?.trim().slice(0, LIST_SEARCH_MAX_LENGTH);
  return search ? { contains: escapeLike(search), mode: 'insensitive' as const } : undefined;
}
