import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe } from 'vitest';
import { BulkActionsBar, type BulkAction } from '../bulk-actions-bar';

describe('BulkActionsBar', () => {
  it('не рендерить нічого коли count=0', () => {
    const { container } = render(
      <BulkActionsBar count={0} selectedIds={[]} actions={[]} onClear={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('показує кількість обраних рядків', () => {
    render(<BulkActionsBar count={5} selectedIds={['a', 'b', 'c', 'd', 'e']} actions={[]} onClear={vi.fn()} />);
    expect(screen.getByText('Обрано: 5')).toBeInTheDocument();
  });

  it('рендерить всі actions як кнопки', () => {
    const actions: BulkAction[] = [
      { id: 'cancel',  label: 'Скасувати',  onClick: vi.fn() },
      { id: 'archive', label: 'Архівувати', onClick: vi.fn() },
    ];
    render(<BulkActionsBar count={2} selectedIds={['1', '2']} actions={actions} onClear={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Архівувати' })).toBeInTheDocument();
  });

  it('action.onClick отримує selectedIds як аргумент', async () => {
    const onClick = vi.fn();
    const actions: BulkAction[] = [{ id: 'cancel', label: 'Скасувати', onClick }];
    render(<BulkActionsBar count={2} selectedIds={['1', '2']} actions={actions} onClear={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Скасувати' }));
    expect(onClick).toHaveBeenCalledWith(['1', '2']);
  });

  it('кнопка очищення викликає onClear', async () => {
    const onClear = vi.fn();
    render(<BulkActionsBar count={1} selectedIds={['1']} actions={[]} onClear={onClear} />);
    await userEvent.click(screen.getByRole('button', { name: 'Скасувати вибір' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('disabled дія не реагує на клік', async () => {
    const onClick = vi.fn();
    const actions: BulkAction[] = [{ id: 'cancel', label: 'Скасувати', disabled: true, onClick }];
    render(<BulkActionsBar count={1} selectedIds={['1']} actions={actions} onClear={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Скасувати' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
