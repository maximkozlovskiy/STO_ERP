import { useState } from 'react';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';
import { EntityPickerField } from '../entity-picker-field';
import { Modal } from '../modal';

interface CpItem {
  id: string;
  primary: string;
  secondary?: string;
}

const ITEMS: CpItem[] = [
  { id: '1', primary: 'Іванов Петро', secondary: '+380501112233' },
  { id: '2', primary: 'Сидоров Олег', secondary: '+380502223344' },
  { id: '3', primary: 'ТОВ Авто', secondary: '+380503334455' },
];

describe('EntityPickerField — search mode (regression guards for 7b58af2c / c7a5fde9)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('рендерить input коли display порожній і onSearch заданий', () => {
    render(
      <EntityPickerField
        display=""
        onSearch={async () => []}
        onSearchSelect={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('показує span замість input коли є display value', () => {
    render(
      <EntityPickerField
        display="Іванов Петро"
        onSearch={async () => []}
        onSearchSelect={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText('Іванов Петро')).toBeInTheDocument();
  });

  it('викликає onSearch з дебаунсом 300мс після введення', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSearch = vi.fn(async () => ITEMS);
    render(
      <EntityPickerField
        display=""
        onSearch={onSearch}
        onSearchSelect={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const input = screen.getByRole('combobox');
    await user.type(input, 'Іван');
    // Before debounce — no call
    expect(onSearch).not.toHaveBeenCalled();
    // Flush debounce
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(onSearch).toHaveBeenCalledWith('Іван');
  });

  it('відкриває dropdown і рендерить результати після resolve', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSearch = vi.fn(async () => ITEMS);
    render(
      <EntityPickerField
        display=""
        onSearch={onSearch}
        onSearchSelect={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    await user.type(screen.getByRole('combobox'), 'Іван');
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });
    expect(screen.getByText('Іванов Петро')).toBeInTheDocument();
    expect(screen.getByText('ТОВ Авто')).toBeInTheDocument();
  });

  it('очищає items і закриває dropdown при порожньому query', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSearch = vi.fn(async () => ITEMS);
    render(
      <EntityPickerField
        display=""
        onSearch={onSearch}
        onSearchSelect={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const input = screen.getByRole('combobox');
    await user.type(input, 'Іван');
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());

    await user.clear(input);
    // Empty path — sync clear without debounce wait
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('викликає onSearchSelect і чистить input після вибору з dropdown', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSearch = vi.fn(async () => ITEMS);
    const onSearchSelect = vi.fn();
    render(
      <EntityPickerField<CpItem>
        display=""
        onSearch={onSearch}
        onSearchSelect={onSearchSelect}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    await user.type(screen.getByRole('combobox'), 'Іван');
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());

    // Click first option
    await user.click(screen.getByText('Іванов Петро'));

    expect(onSearchSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1', primary: 'Іванов Петро' }),
    );
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('стрілки ArrowDown/ArrowUp змінюють activeIndex', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSearch = vi.fn(async () => ITEMS);
    render(
      <EntityPickerField<CpItem>
        display=""
        onSearch={onSearch}
        onSearchSelect={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const input = screen.getByRole('combobox');
    await user.type(input, 'а');
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());

    await user.keyboard('{ArrowDown}');
    await waitFor(() => {
      const opts = screen.getAllByRole('option');
      expect(opts[0]).toHaveAttribute('aria-selected', 'true');
    });
    await user.keyboard('{ArrowDown}');
    await waitFor(() => {
      const opts = screen.getAllByRole('option');
      expect(opts[1]).toHaveAttribute('aria-selected', 'true');
    });
    await user.keyboard('{ArrowUp}');
    await waitFor(() => {
      const opts = screen.getAllByRole('option');
      expect(opts[0]).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('Enter обирає активний пункт', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSearch = vi.fn(async () => ITEMS);
    const onSearchSelect = vi.fn();
    render(
      <EntityPickerField<CpItem>
        display=""
        onSearch={onSearch}
        onSearchSelect={onSearchSelect}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    await user.type(screen.getByRole('combobox'), 'а');
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');
    expect(onSearchSelect).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
  });

  it('Escape закриває dropdown', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSearch = vi.fn(async () => ITEMS);
    render(
      <EntityPickerField<CpItem>
        display=""
        onSearch={onSearch}
        onSearchSelect={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    await user.type(screen.getByRole('combobox'), 'а');
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  // Bug #919: <Modal> слухає Escape на document — без перехоплення список і вікно-власник
  // закривались разом, і введене у вікні губилось.
  it.each([
    ['список результатів', ITEMS],
    ['«Нічого не знайдено»', [] as CpItem[]],
  ])('Escape у вікні з відкритим: %s — закриває лише його, вікно лишається', async (_, found) => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Нова позиція">
        <EntityPickerField<CpItem>
          display=""
          onSearch={vi.fn(async () => found)}
          onSearchSelect={vi.fn()}
          onClear={vi.fn()}
        />
      </Modal>,
    );
    await user.type(screen.getByRole('combobox'), 'а');
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryByRole('listbox') ?? screen.getByText('Нічого не знайдено')).toBeTruthy(),
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Нічого не знайдено')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // Список уже закрито — наступний Escape закриває вікно, як і раніше.
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('race protection: stale "a" не перетирає новіші "ab" результати', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    let resolveA: (items: CpItem[]) => void = () => {};
    const onSearch = vi.fn((q: string) => {
      if (q === 'a') {
        return new Promise<CpItem[]>(resolve => {
          resolveA = resolve;
        });
      }
      return Promise.resolve([{ id: '2', primary: 'AB Result' }]);
    });
    render(
      <EntityPickerField<CpItem>
        display=""
        onSearch={onSearch}
        onSearchSelect={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const input = screen.getByRole('combobox');
    await user.type(input, 'a');
    // wait debounce
    await new Promise(r => setTimeout(r, 350));
    // Now type 'b' → triggers new search
    await user.type(input, 'b');
    await new Promise(r => setTimeout(r, 350));
    // Both promises pending. Resolve 'a' last (stale).
    await act(async () => {
      resolveA([{ id: '1', primary: 'A Result' }]);
      await new Promise(r => setTimeout(r, 50));
    });
    // Only newer "AB Result" should be shown — race guard kicks in.
    await waitFor(() => {
      expect(screen.getByText('AB Result')).toBeInTheDocument();
    });
    expect(screen.queryByText('A Result')).not.toBeInTheDocument();
  });

  it("Кнопка '×' викликає onClear", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(
      <EntityPickerField<CpItem>
        display="Іванов Петро"
        onSearch={async () => []}
        onSearchSelect={vi.fn()}
        onPick={vi.fn()}
        onClear={onClear}
      />,
    );
    await user.click(screen.getByLabelText('Очистити'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("Кнопка '…' (pick) викликає onPick якщо не hidePick", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      <EntityPickerField<CpItem>
        display=""
        onSearch={async () => []}
        onSearchSelect={vi.fn()}
        onPick={onPick}
        onClear={vi.fn()}
      />,
    );
    await user.click(screen.getByLabelText('Обрати'));
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('hidePick=true приховує кнопку pick', () => {
    render(
      <EntityPickerField<CpItem>
        display=""
        onSearch={async () => []}
        onSearchSelect={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
        hidePick
      />,
    );
    expect(screen.queryByLabelText('Обрати')).not.toBeInTheDocument();
  });

  it("Кнопка 'детальніше' (search-icon) disabled якщо onOpenDetail відсутній", () => {
    render(
      <EntityPickerField<CpItem>
        display=""
        onSearch={async () => []}
        onSearchSelect={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Відкрити картку')).toBeDisabled();
  });

  it('hideDetail ховає 🔍 «Відкрити картку», «…» лишається', () => {
    render(
      <EntityPickerField<CpItem>
        display="Toyota"
        onSearch={async () => []}
        onSearchSelect={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
        hideDetail
      />,
    );
    expect(screen.queryByLabelText('Відкрити картку')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Обрати')).toBeInTheDocument();
  });

  it('ariaInvalid / ariaDescribedBy — на полі пошуку', () => {
    render(
      <>
        <p id="cp-err">Оберіть клієнта</p>
        <EntityPickerField<CpItem>
          display=""
          ariaLabel="Клієнт"
          ariaInvalid
          ariaDescribedBy="cp-err"
          onSearch={async () => []}
          onSearchSelect={vi.fn()}
          onClear={vi.fn()}
        />
      </>,
    );
    const input = screen.getByRole('combobox', { name: 'Клієнт' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Оберіть клієнта');
  });

  it('disabled=true вимикає input', () => {
    render(
      <EntityPickerField<CpItem>
        display=""
        onSearch={async () => []}
        onSearchSelect={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
        disabled
      />,
    );
    expect(screen.getByRole('combobox')).toBeDisabled();
  });

  it('ariaLabel прокидається в aria-label input', () => {
    render(
      <EntityPickerField<CpItem>
        display=""
        ariaLabel="Клієнт"
        onSearch={async () => []}
        onSearchSelect={vi.fn()}
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-label', 'Клієнт');
  });

  it('у без-search mode (onSearch не задано) input не рендериться', () => {
    render(<EntityPickerField display="" onPick={vi.fn()} onClear={vi.fn()} />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    // Placeholder span замість input
    expect(screen.getByText('Обрати…')).toBeInTheDocument();
  });
});

// Bug #922: capture-слухач Escape відкритого списку реагував на БУДЬ-ЯКИЙ Escape у документі —
// у вкладеному вікні вибору (кнопка «…») перший Escape «ковтав» невидимий під ним список.
describe('EntityPickerField — Escape не з поля не перехоплюється (Bug #922)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function openList(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByRole('combobox'), 'а');
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
  }

  function WithPicker({ onPickerClose }: { onPickerClose: () => void }) {
    const [picker, setPicker] = useState(false);
    return (
      <Modal open onClose={vi.fn()} title="Нова позиція">
        <EntityPickerField<CpItem>
          display=""
          onSearch={vi.fn(async () => ITEMS)}
          onSearchSelect={vi.fn()}
          onPick={() => setPicker(true)}
          onClear={vi.fn()}
        />
        <Modal
          open={picker}
          onClose={() => {
            onPickerClose();
            setPicker(false);
          }}
          title="Оберіть контрагента"
        >
          <input aria-label="Пошук у вікні вибору" />
        </Modal>
      </Modal>
    );
  }

  it('«…» при відкритому списку: список закрито, перший Escape у вікні вибору закриває його', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onPickerClose = vi.fn();
    render(<WithPicker onPickerClose={onPickerClose} />);
    await openList(user);

    fireEvent.click(screen.getByLabelText('Обрати'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.keyDown(await screen.findByLabelText('Пошук у вікні вибору'), { key: 'Escape' });
    expect(onPickerClose).toHaveBeenCalledTimes(1);
  });

  it('список відкритий, Escape з елемента поза полем — до вікна, а не до списку', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Нова позиція">
        <EntityPickerField<CpItem>
          display=""
          onSearch={vi.fn(async () => ITEMS)}
          onSearchSelect={vi.fn()}
          onClear={vi.fn()}
        />
        <input aria-label="Коментар" />
      </Modal>,
    );
    await openList(user);

    fireEvent.keyDown(screen.getByLabelText('Коментар'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('EntityPickerField — label prop (вирівнювання по одній лінії, як Select/Input)', () => {
  it('без label — обгортка-label не рендериться', () => {
    render(<EntityPickerField display="" onPick={vi.fn()} onClear={vi.fn()} />);
    expect(document.querySelector('label')).toBeNull();
  });

  it('з label — рендерить <label> з текстом', () => {
    render(
      <EntityPickerField display="" label="Постачальник" onPick={vi.fn()} onClear={vi.fn()} />,
    );
    const label = document.querySelector('label');
    expect(label).not.toBeNull();
    expect(label).toHaveTextContent('Постачальник');
  });

  it('required — додає «*» у label (рівно одну зірочку)', () => {
    render(
      <EntityPickerField
        display=""
        label="Постачальник"
        required
        onPick={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const label = document.querySelector('label');
    expect(label?.textContent).toContain('*');
    // Рівно одна зірочка — не дубльована (ручний <span>* прибрано зі споживачів).
    expect((label?.textContent?.match(/\*/g) ?? []).length).toBe(1);
  });

  it('required=false — без зірочки', () => {
    render(<EntityPickerField display="" label="Замовлення" onPick={vi.fn()} onClear={vi.fn()} />);
    expect(document.querySelector('label')?.textContent).not.toContain('*');
  });
});

// Bug #929: після Escape фокус лишається в полі з тим самим текстом — стрілка вниз повертає список.
describe('EntityPickerField — список після Escape (Bug #929)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Escape закрив список — ArrowDown відкриває його знову', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <EntityPickerField<CpItem>
        display=""
        onSearch={vi.fn(async () => ITEMS)}
        onSearchSelect={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    await user.type(screen.getByRole('combobox'), 'а');
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
});
