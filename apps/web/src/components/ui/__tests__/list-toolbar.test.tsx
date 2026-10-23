// Панель списку (docs/PATTERNS.md «Панель списку»): рядок статусів і рядок фільтрів.
//
// Mutation-verify:
//   - ListStatusRow: прибрати `role="group"`                → кейс «група з назвою» падає;
//   - ListFiltersRow: прибрати `flex-wrap` у групі дій       → кейс «дії переносяться» падає;
//   - ListFiltersRow: прибрати `ml-auto`                     → той самий кейс падає;
//   - ListFiltersRow: рендерити обгортку дій без `actions`   → кейс «без дій» падає.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ListFiltersRow, ListStatusRow } from '../list-toolbar';

describe('ListStatusRow', () => {
  it('кнопки — у групі з доступною назвою; перемикач `right` — поза групою', () => {
    render(
      <ListStatusRow label="Статус" right={<button type="button">Мої наряди</button>}>
        <button type="button">Всі</button>
        <button type="button">Чернетка</button>
      </ListStatusRow>,
    );
    const group = screen.getByRole('group', { name: 'Статус' });
    expect(group).toContainElement(screen.getByRole('button', { name: 'Всі' }));
    expect(group).toContainElement(screen.getByRole('button', { name: 'Чернетка' }));
    expect(group).not.toContainElement(screen.getByRole('button', { name: 'Мої наряди' }));
  });
});

describe('ListFiltersRow', () => {
  it('дії притиснуті праворуч і переносяться всередині своєї групи (вузький екран)', () => {
    render(
      <ListFiltersRow actions={<button type="button">+ Товар</button>}>
        <input aria-label="Пошук" />
      </ListFiltersRow>,
    );
    const actions = screen.getByRole('button', { name: '+ Товар' }).parentElement!;
    expect(actions).toHaveClass('ml-auto', 'flex-wrap');
    // Фільтри стоять перед діями.
    expect(actions.previousElementSibling).toBe(screen.getByRole('textbox', { name: 'Пошук' }));
  });

  it('без дій — лише фільтри, без порожньої обгортки', () => {
    const { container } = render(
      <ListFiltersRow>
        <input aria-label="Пошук" />
      </ListFiltersRow>,
    );
    expect(container.firstElementChild!.children).toHaveLength(1);
  });
});
