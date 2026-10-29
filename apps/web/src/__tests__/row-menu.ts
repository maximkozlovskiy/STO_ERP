// Меню «⋯» рядка (`components/ui/row-actions-menu.tsx`) у тестах сторінок: відкрити меню рядка й
// знайти в ньому дію. Сторно й зняття рознесення живуть там, а не кнопкою в рядку
// (UX-огляд 2026-10-29).
import { fireEvent, screen, within } from '@testing-library/react';

export const ROW_MENU_LABEL = 'Дії рядка';

/** Кнопка «⋯» у межах `scope` (рядка); `null` — дій у рядку немає. */
export const rowMenuTrigger = (scope: HTMLElement): HTMLElement | null =>
  within(scope).queryByRole('button', { name: ROW_MENU_LABEL });

/**
 * Дія меню рядка за назвою або `null` (меню немає чи такої дії в ньому немає). Знайдена дія лишає
 * меню відкритим (щоб по ній клікнути); меню без потрібної дії закривається кліком по «⋯».
 */
export function rowMenuItem(scope: HTMLElement, name: string): HTMLElement | null {
  const trigger = rowMenuTrigger(scope);
  if (!trigger) return null;
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  const menus = screen.getAllByRole('menu');
  const item = within(menus[menus.length - 1]!).queryByRole('menuitem', { name });
  if (!item) fireEvent.click(trigger);
  return item;
}

/** Назви дій у меню рядка (порожньо — меню немає); меню після читання закривається. */
export function rowMenuItemNames(scope: HTMLElement): string[] {
  const trigger = rowMenuTrigger(scope);
  if (!trigger) return [];
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  const menus = screen.getAllByRole('menu');
  const names = within(menus[menus.length - 1]!)
    .getAllByRole('menuitem')
    .map(i => i.textContent ?? '');
  fireEvent.click(trigger);
  return names;
}
