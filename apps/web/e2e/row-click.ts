import type { Locator } from '@playwright/test';

/**
 * Комірка рядка списку для кліку «по рядку» (бічна панель): не чекбокс і не номер документа /
 * ім'я контрагента — клік по номеру відкриває КАРТКУ (UX-огляд 2026-10-29, `DocLink`).
 */
export function rowBodyCell(row: Locator): Locator {
  return row.locator('td:not(:has(input)):not(:has([data-doc-link]))').first();
}
