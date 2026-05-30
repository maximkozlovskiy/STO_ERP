import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe } from 'vitest';
import { SavedFiltersBar, SaveFilterButton } from '../saved-filters-bar';
import { type SavedFilter } from '@/hooks/useSavedFilters';

interface F extends Record<string, unknown> {
  status: string;
}

function makePreset(id: string, name: string, status = 'IN_PROGRESS'): SavedFilter<F> {
  return { id, name, filters: { status }, createdAt: 1700000000000 };
}

describe('SavedFiltersBar', () => {
  it('показує підказку коли немає збережених фільтрів і не відкритий save dialog', () => {
    render(<SavedFiltersBar<F> saved={[]} onApply={vi.fn()} onSave={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText('Немає збережених фільтрів')).toBeInTheDocument();
  });

  it('рендерить кожен пресет з його іменем', () => {
    render(
      <SavedFiltersBar<F>
        saved={[makePreset('p1', 'В роботі'), makePreset('p2', 'Завершені', 'COMPLETED')]}
        onApply={vi.fn()}
        onSave={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'В роботі' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Завершені' })).toBeInTheDocument();
  });

  it('клік по пресету викликає onApply з цим пресетом', async () => {
    const onApply = vi.fn();
    const preset = makePreset('p1', 'Активні');
    render(
      <SavedFiltersBar<F> saved={[preset]} onApply={onApply} onSave={vi.fn()} onRemove={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Активні' }));
    expect(onApply).toHaveBeenCalledWith(preset);
  });

  it('activeId підсвічує відповідний пресет', () => {
    render(
      <SavedFiltersBar<F>
        saved={[makePreset('p1', 'A'), makePreset('p2', 'B')]}
        activeId="p1"
        onApply={vi.fn()}
        onSave={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const active = screen.getByRole('button', { name: 'A' });
    expect(active.className).toMatch(/bg-primary/);
  });

  it('клік по "Видалити" викликає onRemove з id пресета', async () => {
    const onRemove = vi.fn();
    render(
      <SavedFiltersBar<F>
        saved={[makePreset('p1', 'A')]}
        onApply={vi.fn()}
        onSave={vi.fn()}
        onRemove={onRemove}
      />,
    );
    const removeBtn = screen.getByRole('button', { name: /Видалити фільтр "A"/ });
    await userEvent.click(removeBtn);
    expect(onRemove).toHaveBeenCalledWith('p1');
  });

  it('клік "Зберегти" відкриває input', async () => {
    render(<SavedFiltersBar<F> saved={[]} onApply={vi.fn()} onSave={vi.fn()} onRemove={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Зберегти/ }));
    expect(screen.getByPlaceholderText('Назва фільтру...')).toBeInTheDocument();
  });

  it('Enter у input викликає onSave з trimmed name', async () => {
    const onSave = vi.fn();
    render(<SavedFiltersBar<F> saved={[]} onApply={vi.fn()} onSave={onSave} onRemove={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Зберегти/ }));
    const input = screen.getByPlaceholderText('Назва фільтру...');
    await userEvent.type(input, '  Мій фільтр  ');
    await userEvent.keyboard('{Enter}');
    expect(onSave).toHaveBeenCalledWith('Мій фільтр');
  });

  it("порожнє ім'я (тільки whitespace) не викликає onSave", async () => {
    const onSave = vi.fn();
    render(<SavedFiltersBar<F> saved={[]} onApply={vi.fn()} onSave={onSave} onRemove={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Зберегти/ }));
    const input = screen.getByPlaceholderText('Назва фільтру...');
    await userEvent.type(input, '   ');
    await userEvent.keyboard('{Enter}');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Escape у input закриває save dialog', async () => {
    render(<SavedFiltersBar<F> saved={[]} onApply={vi.fn()} onSave={vi.fn()} onRemove={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Зберегти/ }));
    const input = screen.getByPlaceholderText('Назва фільтру...');
    expect(input).toBeInTheDocument();
    // Focus the input directly — autofocus setTimeout(30) is unreliable in jsdom.
    input.focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByPlaceholderText('Назва фільтру...')).not.toBeInTheDocument();
  });

  // ─── hideSaveButton prop — інверсна-логіка регресії (Bug #194) ─────────────

  it('hideSaveButton=true приховує inline "Зберегти" button', () => {
    render(
      <SavedFiltersBar<F>
        saved={[]}
        onApply={vi.fn()}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        hideSaveButton
      />,
    );
    expect(screen.queryByRole('button', { name: /Зберегти/ })).not.toBeInTheDocument();
  });

  it('hideSaveButton=true приховує "Немає збережених фільтрів" hint навіть при saved=[]', () => {
    render(
      <SavedFiltersBar<F>
        saved={[]}
        onApply={vi.fn()}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        hideSaveButton
      />,
    );
    expect(screen.queryByText('Немає збережених фільтрів')).not.toBeInTheDocument();
  });

  it('hideSaveButton=true залишає preset-кнопки і remove-кнопки видимими', () => {
    const onApply = vi.fn();
    const onRemove = vi.fn();
    render(
      <SavedFiltersBar<F>
        saved={[makePreset('p1', 'Активні'), makePreset('p2', 'Завершені', 'COMPLETED')]}
        onApply={onApply}
        onSave={vi.fn()}
        onRemove={onRemove}
        hideSaveButton
      />,
    );
    expect(screen.getByRole('button', { name: 'Активні' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Завершені' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Видалити фільтр "Активні"/ })).toBeInTheDocument();
    // sanity: inline save кнопка прихована
    expect(screen.queryByRole('button', { name: /^Зберегти$/ })).not.toBeInTheDocument();
  });
});

// ─── SaveFilterButton — новий standalone icon-only компонент (Bug #193) ──────

describe('SaveFilterButton', () => {
  it('за замовчуванням рендерить icon-кнопку з title="Зберегти фільтр" (a11y)', () => {
    render(<SaveFilterButton onSave={vi.fn()} />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('title', 'Зберегти фільтр');
    expect(btn).toHaveAttribute('type', 'button');
    // input ще не показано
    expect(screen.queryByPlaceholderText('Назва фільтру...')).not.toBeInTheDocument();
  });

  it('клік по icon-кнопці відкриває inline-input', async () => {
    render(<SaveFilterButton onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByPlaceholderText('Назва фільтру...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Зберегти' })).toBeInTheDocument();
  });

  it('Enter у input викликає onSave з trimmed name і закриває input', async () => {
    const onSave = vi.fn();
    render(<SaveFilterButton onSave={onSave} />);
    await userEvent.click(screen.getByRole('button'));
    const input = screen.getByPlaceholderText('Назва фільтру...');
    await userEvent.type(input, '  Мій фільтр  ');
    await userEvent.keyboard('{Enter}');
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('Мій фільтр');
    // Після успішного save — input закривається, icon-кнопка повертається
    expect(screen.queryByPlaceholderText('Назва фільтру...')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('title', 'Зберегти фільтр');
  });

  it('клік по кнопці "Зберегти" викликає onSave з trimmed name', async () => {
    const onSave = vi.fn();
    render(<SaveFilterButton onSave={onSave} />);
    await userEvent.click(screen.getByRole('button'));
    const input = screen.getByPlaceholderText('Назва фільтру...');
    await userEvent.type(input, 'Назва');
    await userEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    expect(onSave).toHaveBeenCalledWith('Назва');
  });

  it('порожнє name (тільки whitespace) не викликає onSave і "Зберегти" disabled', async () => {
    const onSave = vi.fn();
    render(<SaveFilterButton onSave={onSave} />);
    await userEvent.click(screen.getByRole('button'));
    const input = screen.getByPlaceholderText('Назва фільтру...');
    // Кнопка "Зберегти" disabled коли input порожній
    const saveBtn = screen.getByRole('button', { name: 'Зберегти' });
    expect(saveBtn).toBeDisabled();
    // Whitespace не активує
    await userEvent.type(input, '   ');
    expect(saveBtn).toBeDisabled();
    await userEvent.keyboard('{Enter}');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Escape у input закриває inline-input і скидає name', async () => {
    const onSave = vi.fn();
    render(<SaveFilterButton onSave={onSave} />);
    await userEvent.click(screen.getByRole('button'));
    const input = screen.getByPlaceholderText('Назва фільтру...');
    input.focus();
    await userEvent.type(input, 'Деяка назва');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByPlaceholderText('Назва фільтру...')).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    // Re-open — поле має бути порожнє (name скинутий)
    await userEvent.click(screen.getByRole('button'));
    const input2 = screen.getByPlaceholderText('Назва фільтру...');
    expect(input2).toHaveValue('');
  });

  it('кнопка X закриває inline-input і скидає name', async () => {
    render(<SaveFilterButton onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole('button'));
    const input = screen.getByPlaceholderText('Назва фільтру...');
    await userEvent.type(input, 'Тест');
    // X кнопка — друга button після "Зберегти"
    const buttons = screen.getAllByRole('button');
    // [icon-bookmark вже не видно бо open], buttons: [Зберегти, X]
    // Перевірка через querySelector — найпростіше: X має svg.lucide-x
    const xBtn = buttons.find(b => b.querySelector('svg'));
    expect(xBtn).toBeTruthy();
    await userEvent.click(xBtn as HTMLElement);
    expect(screen.queryByPlaceholderText('Назва фільтру...')).not.toBeInTheDocument();
  });

  it('className з пропсу застосовується до icon-кнопки', () => {
    render(<SaveFilterButton onSave={vi.fn()} className="custom-cls" />);
    expect(screen.getByRole('button').className).toMatch(/custom-cls/);
  });
});
