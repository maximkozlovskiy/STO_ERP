// Пікер товарів правила: безпечні й повні масові дії (BR-GOOD-009, блок 4 №20, №21).
//
// Що стережуть ці тести:
//  - «Зняти всі показані» понад DESELECT_CONFIRM_OVER (20) товарів — лише після підтвердження;
//    до 20 включно — одразу, як і раніше; «Скасувати» нічого не знімає (№20);
//  - «Додати всю категорію» з'являється, лише коли обрано категорію, і передає її id (№21).
//
// Mutation-verify (2026-11-14): поріг `>` → `>=` → кейс «рівно 20 — одразу» падає; прибрати
// підтвердження → кейс «21 — питає» падає; кнопка категорії без `selectedCatId` → кейс «без
// категорії кнопки немає» падає.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { DESELECT_CONFIRM_OVER, GoodPickerModal } from '../GoodPickerModal';
import type { CategoryNode } from '../category-tree';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const CATEGORIES: CategoryNode[] = [
  {
    id: 'cat-oil',
    name: 'Мастила',
    isActive: true,
    children: [{ id: 'cat-motor', name: 'Моторні', isActive: true, children: [] }],
  },
];

const goods = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `g${i}`,
    primary: `Товар ${i}`,
    name: `Товар ${i}`,
    salePrice: 100,
  }));

let shown = goods(3);

beforeEach(() => {
  apiFetchMock.mockReset();
  if (typeof localStorage !== 'undefined') localStorage.clear();
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/good-categories') return Promise.resolve(CATEGORIES);
    if (path.startsWith('/goods/stock-totals')) return Promise.resolve([]);
    if (path.startsWith('/goods')) return Promise.resolve({ items: shown });
    return Promise.resolve({ items: [] });
  });
});

const renderPicker = (props: Partial<Parameters<typeof GoodPickerModal>[0]> = {}) =>
  render(
    <GoodPickerModal
      open
      onClose={vi.fn()}
      onSelect={vi.fn()}
      multiple
      onSelectMany={vi.fn()}
      {...props}
    />,
  );

describe('«Зняти всі показані» понад 20 — з підтвердженням (№20)', () => {
  it('рівно 20 показаних доданих — знімаються одразу, без питання', async () => {
    shown = goods(DESELECT_CONFIRM_OVER);
    const onDeselectMany = vi.fn();
    const user = userEvent.setup();
    renderPicker({ onDeselectMany, selectedIds: shown.map(g => g.id) });
    await screen.findByRole('button', { name: /Товар 19/ });

    await user.click(screen.getByRole('button', { name: 'Зняти всі' }));

    expect(onDeselectMany).toHaveBeenCalledWith(shown.map(g => g.id));
    expect(screen.queryByText('Зняти всі показані товари?')).not.toBeInTheDocument();
  });

  it('21 показаний доданий — спершу питає; «Скасувати» нічого не знімає, «Зняти» — знімає', async () => {
    shown = goods(DESELECT_CONFIRM_OVER + 1);
    const onDeselectMany = vi.fn();
    const user = userEvent.setup();
    renderPicker({ onDeselectMany, selectedIds: shown.map(g => g.id) });
    await screen.findByRole('button', { name: /Товар 20/ });

    await user.click(screen.getByRole('button', { name: 'Зняти всі' }));
    expect(await screen.findByText('Зняти всі показані товари?')).toBeInTheDocument();
    expect(screen.getByText('Зі списку буде прибрано товарів: 21.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Скасувати' }));
    await waitFor(() =>
      expect(screen.queryByText('Зняти всі показані товари?')).not.toBeInTheDocument(),
    );
    expect(onDeselectMany).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Зняти всі' }));
    await user.click(await screen.findByRole('button', { name: 'Зняти' }));
    expect(onDeselectMany).toHaveBeenCalledWith(shown.map(g => g.id));
  });
});

describe('«Додати всю категорію» (№21)', () => {
  it('без обраної категорії кнопки немає; з категорією — передає її id', async () => {
    shown = goods(2);
    const onAddCategory = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPicker({ onAddCategory, addCategoryLabel: 'Додати всю категорію' });
    await screen.findByRole('button', { name: /Товар 1/ });
    expect(screen.queryByRole('button', { name: 'Додати всю категорію' })).not.toBeInTheDocument();

    await user.click(await screen.findByText('Мастила'));
    await user.click(await screen.findByRole('button', { name: 'Додати всю категорію' }));

    expect(onAddCategory).toHaveBeenCalledWith('cat-oil');
  });

  it('без обробника (інші пікери) кнопки немає навіть з категорією', async () => {
    shown = goods(2);
    const user = userEvent.setup();
    renderPicker();
    await user.click(await screen.findByText('Мастила'));
    await screen.findByRole('button', { name: /Товар 1/ });
    expect(screen.queryByRole('button', { name: 'Додати всю категорію' })).not.toBeInTheDocument();
  });
});
