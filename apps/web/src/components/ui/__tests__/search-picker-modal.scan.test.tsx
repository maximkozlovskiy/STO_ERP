// Regression-guard для scanner-race у SearchPickerModal (fix 6e46a21b).
//
// SearchPickerModal — товарний пікер для PurchaseOrder / StockDocument / SupplierReturn.
// Сканер друкує ШК + Enter ШВИДШЕ за debounce (300ms). На момент Enter `items` ще
// показує ДО-скан-результати (початковий список або старий query). Enter-гілка мусить:
//   - якщо timeoutRef.current (debounce pending) → clearTimeout → fetch(query) →
//     setItems(fresh) → scanSubmit(fresh) → select;
//   - інакше → trySelect(items) за поточними (свіжими) items.
//
// Дискримінація: revert flush-гілки → вибір іде за stale `items` (без сканованого
// товару) → onSelect не викликається / викликається не з тим товаром → тести падають.
//
// ⚠️ ТЕСТ-ІНТЕГРІТІ: Enter через fireEvent.keyDown (native) щоб контролювати момент
// натискання відносно debounce через fake timers. fetchItems повертає сканований товар
// ТІЛЬКИ для точного query — доводить що вибір іде зі СВІЖИХ результатів, не stale.

import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';
import { SearchPickerModal, type SearchPickerItem } from '../search-picker-modal';
import { pickScannedGood } from '@/lib/barcode';

interface GoodItem extends SearchPickerItem {
  barcode?: string | null;
  barcodes?: string[];
}

// Початковий список (fetchItems('')) — те що показано ДО скану.
const initial: GoodItem[] = [
  { id: 'a', primary: 'Болт А', barcode: '111' },
  { id: 'b', primary: 'Гайка Б', barcode: '222' },
];
const scanned: GoodItem = { id: 'z', primary: 'Сканований Z', barcode: '4820777' };

// fetch повертає сканований товар ЛИШЕ для точного ШК; '' → початковий список.
const makeFetch = () =>
  vi.fn(async (q: string) => (q === '4820777' ? [scanned] : q === '' ? initial : []));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderModal(fetchItems: ReturnType<typeof makeFetch>, onSelect = vi.fn()) {
  render(
    <SearchPickerModal<GoodItem>
      open
      onClose={vi.fn()}
      title="Товар"
      onSelect={onSelect}
      fetchItems={fetchItems}
      scanSubmit={(items, typed) => pickScannedGood(items, typed)}
    />,
  );
  const input = screen.getByPlaceholderText('Пошук...') as HTMLInputElement;
  return { input, onSelect };
}

describe('SearchPickerModal — scanner-race (сканер ШК)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('scanner-race: Enter при PENDING debounce → flush+fetch+вибір свіжого товару', async () => {
    const fetchItems = makeFetch();
    const { input, onSelect } = renderModal(fetchItems);
    // Дати відпрацювати початковому fetchItems('') → items = initial.
    await flushMicrotasks();
    expect(onSelect).not.toHaveBeenCalled();

    // Сканер: друкуємо повний ШК і ОДРАЗУ Enter — БЕЗ advanceTimersByTime → debounce pending,
    // items досі = initial (сканованого товару там НЕМАЄ).
    act(() => {
      fireEvent.change(input, { target: { value: '4820777' } });
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flushMicrotasks();

    expect(fetchItems).toHaveBeenCalledWith('4820777');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].id).toBe('z'); // свіжий сканований, не stale 'a'/'b'
  });

  it('scanner-race: flush не лишає «хвостового» debounce (жодного повторного fetch/select)', async () => {
    const fetchItems = makeFetch();
    const { input, onSelect } = renderModal(fetchItems);
    await flushMicrotasks();
    act(() => {
      fireEvent.change(input, { target: { value: '4820777' } });
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flushMicrotasks();
    const fetchesAfterFlush = fetchItems.mock.calls.length;
    // Прокрутити будь-який залишковий debounce (мав бути очищений через clearTimeout+null).
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await flushMicrotasks();
    expect(fetchItems.mock.calls.length).toBe(fetchesAfterFlush);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('#4: помилка flush fetch → error показано, без вибору, модал не закрито', async () => {
    const onClose = vi.fn();
    const fetchItems = vi.fn(async (q: string) => {
      if (q === '') return initial;
      throw new Error('network fail');
    });
    const onSelect = vi.fn();
    render(
      <SearchPickerModal<GoodItem>
        open
        onClose={onClose}
        title="Товар"
        onSelect={onSelect}
        fetchItems={fetchItems}
        scanSubmit={(items, typed) => pickScannedGood(items, typed)}
      />,
    );
    const input = screen.getByPlaceholderText('Пошук...') as HTMLInputElement;
    await flushMicrotasks();
    act(() => {
      fireEvent.change(input, { target: { value: '4820777' } });
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flushMicrotasks();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled(); // handleClose не викликано → модал лишається
    expect(screen.getByText('network fail')).toBeTruthy(); // error показано (можна ретраїти)
  });

  it('fall-through: debounce вже спрацював → вибір за поточними (свіжими) items', async () => {
    const fetchItems = makeFetch();
    const { input, onSelect } = renderModal(fetchItems);
    await flushMicrotasks();
    act(() => {
      fireEvent.change(input, { target: { value: '4820777' } });
    });
    // Даємо debounce спрацювати → timeoutRef.current стає null, items = [scanned].
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await flushMicrotasks();
    // Тепер Enter має піти fall-through гілкою trySelect(items) з поточними свіжими items.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].id).toBe('z');
  });

  it('без scanSubmit → Enter нічого не флашить/вибирає (не-товарні пікери)', async () => {
    const fetchItems = makeFetch();
    const onSelect = vi.fn();
    render(
      <SearchPickerModal<GoodItem>
        open
        onClose={vi.fn()}
        title="Контрагент"
        onSelect={onSelect}
        fetchItems={fetchItems}
      />,
    );
    const input = screen.getByPlaceholderText('Пошук...') as HTMLInputElement;
    await flushMicrotasks();
    act(() => {
      fireEvent.change(input, { target: { value: '4820777' } });
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flushMicrotasks();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
