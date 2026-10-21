// Bug #920: Escape у відкритому списку SearchCombobox закривав і вікно-власник («+ Запчастина» в
// наряді) — <Modal> слухає Escape на document. Перший Escape — лише список, другий — вікно.

import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';
import { SearchCombobox } from '../search-combobox';
import { Modal } from '../modal';

interface Good {
  id: string;
}

async function typeAndSettle(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  await act(async () => {
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SearchCombobox — Escape у вікні (Bug #920)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([
    ['список результатів', [{ id: 'a', primary: 'Фільтр оливи' }]],
    ['«Нічого не знайдено»', [] as Array<Good & { primary: string }>],
  ])('відкрито: %s — Escape закриває лише його, вікно лишається', async (_, found) => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Додати запчастину">
        <SearchCombobox<Good> value="" onSelect={vi.fn()} fetchItems={vi.fn(async () => found)} />
      </Modal>,
    );
    const input = screen.getByRole('combobox');
    await typeAndSettle(input, 'фі');
    expect(
      found.length ? screen.getByRole('listbox') : screen.getByText(/Нічого не знайдено/),
    ).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/Нічого не знайдено/)).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// Bug #922: слухач реагував на Escape з будь-якого місця документа — у вкладеному вікні чи поза
// полем перший Escape «ковтав» відкритий список, а не доходив до вікна.
describe('SearchCombobox — Escape не з поля не перехоплюється (Bug #922)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('список відкритий, Escape з елемента поза полем — до вікна', async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Додати запчастину">
        <SearchCombobox<Good>
          value=""
          onSelect={vi.fn()}
          fetchItems={vi.fn(async () => [{ id: 'a', primary: 'Фільтр оливи' }])}
        />
        <input aria-label="Кількість" />
      </Modal>,
    );
    await typeAndSettle(screen.getByRole('combobox'), 'фі');
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByLabelText('Кількість'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// Bug #929: після Escape фокус лишається в полі з тим самим текстом — стрілка вниз повертає список.
describe('SearchCombobox — список після Escape (Bug #929)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('Escape закрив список — ArrowDown відкриває його знову, без нового запиту', async () => {
    const fetchItems = vi.fn(async () => [{ id: 'a', primary: 'Фільтр оливи' }]);
    render(<SearchCombobox<Good> value="" onSelect={vi.fn()} fetchItems={fetchItems} />);
    const input = screen.getByRole('combobox');
    await typeAndSettle(input, 'фі');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(fetchItems).toHaveBeenCalledTimes(1);
  });
});
