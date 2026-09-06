// Regression-guard для scan-submit у SearchCombobox (сканер ШК).
//
// Що покриваємо (feat 2b759604 — сканер товару):
//   1. Нормальний потік: користувач/сканер друкує ШК → debounce fetch → dropdown open →
//      Enter → pickScannedGood знаходить точний ШК → onSelect викликається з тим товаром.
//   2. #6 guard: `handleKeyDown` має `if (!open || items.length === 0) return` ПЕРШИМ рядком.
//      Enter ДО того як debounce fetch повернувся (open===false) → scanSubmit НЕ викликається,
//      onSelect не спрацьовує (нічого не «вгадується» на порожньому/старому списку).
//   3. Точний ШК-збіг серед КІЛЬКОХ результатів → береться саме той (не перший у списку).
//
// ⚠️ ТЕСТ-ІНТЕГРІТІ: Enter через fireEvent.keyDown (native) на input — не userEvent.keyboard,
// щоб контролювати момент натискання відносно debounce (300ms) через fake timers.

import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';
import { SearchCombobox } from '../search-combobox';
import { pickScannedGood } from '@/lib/barcode';

interface Good {
  id: string;
  barcode?: string | null;
  barcodes?: string[];
}

const goods: (Good & { primary: string; secondary?: string })[] = [
  { id: 'a', barcode: '111', primary: 'Болт А' },
  { id: 'b', barcode: '4820000000012', primary: 'Олива B' },
  { id: 'c', barcode: '333', primary: 'Фільтр C' },
];

function renderCombobox(onSelect = vi.fn()) {
  const fetchItems = vi.fn(async () => goods);
  // Обгортаємо pickScannedGood щоб перевіряти чи handleKeyDown взагалі дійшов до scanSubmit
  // (guard `if (!open || items.length===0) return` мусить блокувати виклик до відкриття списку).
  const scanSubmit = vi.fn((items: (Good & { primary: string })[], typed: string) =>
    pickScannedGood(items, typed),
  );
  render(
    <SearchCombobox<Good>
      value=""
      onSelect={onSelect}
      fetchItems={fetchItems}
      scanSubmit={scanSubmit}
    />,
  );
  const input = screen.getByRole('combobox') as HTMLInputElement;
  return { input, onSelect, fetchItems, scanSubmit };
}

describe('SearchCombobox — scan-submit (сканер ШК)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('Enter після відкриття списку + точний ШК → onSelect того товару', async () => {
    const { input, onSelect } = renderCombobox();
    // Друкуємо повний ШК товару b.
    act(() => {
      fireEvent.change(input, { target: { value: '4820000000012' } });
    });
    // Чекаємо debounce (300ms) + мікротаску fetch.
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    // Dropdown має відкритися з результатами.
    expect(screen.getByRole('listbox')).toBeTruthy();
    // Enter (сканер) → авто-вибір за точним ШК.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].id).toBe('b'); // саме товар з ШК 4820…, не перший у списку
  });

  it('#6 guard: Enter ДО повернення fetch (open===false) → scanSubmit НЕ викликається', () => {
    const { input, onSelect, scanSubmit } = renderCombobox();
    // Сканер друкує швидко і одразу Enter — debounce (300ms) ще не спрацював → open=false.
    act(() => {
      fireEvent.change(input, { target: { value: '4820000000012' } });
      fireEvent.keyDown(input, { key: 'Enter' }); // до advanceTimersByTime
    });
    // guard `if (!open || items.length===0) return` блокує до відкриття списку —
    // scanSubmit навіть не викликається (дискримінує видалення guard).
    expect(scanSubmit).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('немає точного ШК серед кількох → onSelect НЕ викликається (не вгадуємо)', async () => {
    const { input, onSelect } = renderCombobox();
    act(() => {
      fireEvent.change(input, { target: { value: 'олив' } }); // не точний ШК, кілька б результатів
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
