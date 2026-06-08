import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';
import { EntityPickerField } from '../entity-picker-field';

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
