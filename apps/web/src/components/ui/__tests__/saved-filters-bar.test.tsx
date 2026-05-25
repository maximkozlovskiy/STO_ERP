import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe } from 'vitest';
import { SavedFiltersBar } from '../saved-filters-bar';
import { type SavedFilter } from '@/hooks/useSavedFilters';

interface F extends Record<string, unknown> { status: string }

function makePreset(id: string, name: string, status = 'IN_PROGRESS'): SavedFilter<F> {
  return { id, name, filters: { status }, createdAt: 1700000000000 };
}

describe('SavedFiltersBar', () => {
  it('показує підказку коли немає збережених фільтрів і не відкритий save dialog', () => {
    render(
      <SavedFiltersBar<F>
        saved={[]}
        onApply={vi.fn()}
        onSave={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
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
      <SavedFiltersBar<F>
        saved={[preset]}
        onApply={onApply}
        onSave={vi.fn()}
        onRemove={vi.fn()}
      />,
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
    render(
      <SavedFiltersBar<F>
        saved={[]}
        onApply={vi.fn()}
        onSave={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Зберегти/ }));
    expect(screen.getByPlaceholderText('Назва фільтру...')).toBeInTheDocument();
  });

  it('Enter у input викликає onSave з trimmed name', async () => {
    const onSave = vi.fn();
    render(
      <SavedFiltersBar<F>
        saved={[]}
        onApply={vi.fn()}
        onSave={onSave}
        onRemove={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Зберегти/ }));
    const input = screen.getByPlaceholderText('Назва фільтру...');
    await userEvent.type(input, '  Мій фільтр  ');
    await userEvent.keyboard('{Enter}');
    expect(onSave).toHaveBeenCalledWith('Мій фільтр');
  });

  it('порожнє ім\'я (тільки whitespace) не викликає onSave', async () => {
    const onSave = vi.fn();
    render(
      <SavedFiltersBar<F>
        saved={[]}
        onApply={vi.fn()}
        onSave={onSave}
        onRemove={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Зберегти/ }));
    const input = screen.getByPlaceholderText('Назва фільтру...');
    await userEvent.type(input, '   ');
    await userEvent.keyboard('{Enter}');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Escape у input закриває save dialog', async () => {
    render(
      <SavedFiltersBar<F>
        saved={[]}
        onApply={vi.fn()}
        onSave={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Зберегти/ }));
    const input = screen.getByPlaceholderText('Назва фільтру...');
    expect(input).toBeInTheDocument();
    // Focus the input directly — autofocus setTimeout(30) is unreliable in jsdom.
    input.focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByPlaceholderText('Назва фільтру...')).not.toBeInTheDocument();
  });
});
