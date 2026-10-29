import type { Locator, Page } from '@playwright/test';

/**
 * Комірка рядка списку для кліку «по рядку» (бічна панель): не чекбокс і не номер документа /
 * ім'я контрагента — клік по номеру відкриває КАРТКУ (UX-огляд 2026-10-29, `DocLink`).
 */
export function rowBodyCell(row: Locator): Locator {
  return row.locator('td:not(:has(input)):not(:has([data-doc-link]))').first();
}

/** Кнопка меню «⋯» рядка (`RowActionsMenu`): сторно й зняття рознесення живуть у ньому. */
export function rowMenuButton(row: Locator): Locator {
  return row.getByRole('button', { name: 'Дії рядка' });
}

/** Відкрити меню «⋯» рядка й вибрати дію. */
export async function clickRowMenuItem(page: Page, row: Locator, name: string): Promise<void> {
  await rowMenuButton(row).click();
  await page.getByRole('menu').getByRole('menuitem', { name, exact: true }).click();
}
