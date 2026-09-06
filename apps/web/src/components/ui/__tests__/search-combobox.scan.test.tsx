// Regression-guard для scan-submit у SearchCombobox (сканер ШК).
//
// Що покриваємо:
//   1. Нормальний потік: користувач/сканер друкує ШК → debounce fetch → dropdown open →
//      Enter → pickScannedGood знаходить точний ШК → onSelect викликається з тим товаром.
//   2. Scanner-race (fix 6e46a21b): Enter приходить ДО спрацювання debounce (сканер друкує
//      ШК+Enter швидше за 300ms) → handleKeyDown ФЛАШИТЬ відкладений fetch, тягне свіжі
//      результати і вибирає товар — НЕ мовчки ігнорує. Дискримінація: без flush-гілки
//      onSelect не викликається взагалі (стара «guard тихо ковтає» поведінка).
//   3. Точний ШК-збіг серед КІЛЬКОХ результатів → береться саме той (не перший у списку).
//   4. Flush fetch помилка → catch, без краху, без вибору.
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

// Прогнати мікротаски проміса, поки таймери фейкові (fetch .then/.catch чейни).
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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

  // ── Scanner-race (fix 6e46a21b) — головний дискримінуючий тест ────────────────
  // Сценарій: сканер друкує ШК і Enter ШВИДШЕ за debounce (300ms). На момент Enter
  // debounceRef.current !== null (fetch ще не стартував), items[] порожній/старий.
  // Flush-гілка мусить: clearTimeout → fetch(q) → setItems → scanSubmit(fresh) → select.
  // fetchItems повертає товар ТІЛЬКИ для точного query — доводить що вибір іде зі СВІЖИХ
  // результатів (а не зі stale items, яких на момент Enter немає).
  it('scanner-race: Enter при PENDING debounce → flush+fetch+вибір свіжого товару', async () => {
    const onSelect = vi.fn();
    const scanned = { id: 'z', barcode: '4820777', primary: 'Сканований Z' };
    // fetch повертає scanned товар ЛИШЕ для точного ШК; інакше порожньо.
    const fetchItems = vi.fn(async (q: string) => (q === '4820777' ? [scanned] : []));
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

    // Сканер: друкуємо повний ШК і ОДРАЗУ Enter — БЕЗ advanceTimersByTime → debounce pending.
    act(() => {
      fireEvent.change(input, { target: { value: '4820777' } });
    });
    // debounce ще не спрацював (pending); Enter має флашити.
    fireEvent.keyDown(input, { key: 'Enter' });
    // Резолвимо fetch промісу flush-гілки.
    await flushMicrotasks();

    expect(fetchItems).toHaveBeenCalledWith('4820777');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].id).toBe('z'); // свіжий сканований товар, не null/stale
  });

  // Дублікат-guard: після flush+select оригінальний debounce НЕ дофетчує і НЕ переобирає.
  // (Enter-гілка робить clearTimeout+null; жоден [query]-effect не перепланує таймер.)
  it('scanner-race: flush не лишає «хвостового» debounce (жодного повторного fetch/select)', async () => {
    const onSelect = vi.fn();
    const scanned = { id: 'z', barcode: '4820777', primary: 'Сканований Z' };
    const fetchItems = vi.fn(async (q: string) => (q === '4820777' ? [scanned] : []));
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
    act(() => {
      fireEvent.change(input, { target: { value: '4820777' } });
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flushMicrotasks();
    const fetchesAfterFlush = fetchItems.mock.calls.length;
    // Прокрутити будь-який «залишковий» debounce-таймер (мав бути очищений).
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await flushMicrotasks();
    expect(fetchItems.mock.calls.length).toBe(fetchesAfterFlush); // жодного зайвого fetch
    expect(onSelect).toHaveBeenCalledTimes(1); // рівно один select
  });

  // #4: flush fetch кидає помилку → catch, без краху, без вибору (dropdown лишається).
  it('scanner-race: помилка flush fetch → без вибору, без краху', async () => {
    const onSelect = vi.fn();
    const fetchItems = vi.fn(async () => {
      throw new Error('network');
    });
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
    act(() => {
      fireEvent.change(input, { target: { value: '4820777' } });
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flushMicrotasks();
    expect(onSelect).not.toHaveBeenCalled();
  });

  // #5: без scanSubmit (не-товарний combobox) flush-гілка НЕ активна — стара поведінка.
  it('#5: combobox БЕЗ scanSubmit → Enter при pending debounce нічого не флашить/вибирає', async () => {
    const onSelect = vi.fn();
    const fetchItems = vi.fn(async () => goods);
    render(<SearchCombobox<Good> value="" onSelect={onSelect} fetchItems={fetchItems} />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: '4820000000012' } });
    });
    fireEvent.keyDown(input, { key: 'Enter' }); // pending debounce, але scanSubmit відсутній
    await flushMicrotasks();
    // Жодного flush-fetch поза debounce: fetchItems ще не викликаний (debounce не спрацював).
    expect(fetchItems).not.toHaveBeenCalled();
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
