import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe } from 'vitest';
import { InlineEditCell, InlineViewCell } from '../inline-edit-cell';

describe('InlineEditCell', () => {
  it('рендерить input з початковим value', () => {
    render(<InlineEditCell value="Hello" onCommit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('textbox')).toHaveValue('Hello');
  });

  it('Enter викликає onCommit з поточним value', async () => {
    const onCommit = vi.fn();
    render(<InlineEditCell value="Hello" onCommit={onCommit} onCancel={vi.fn()} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, 'World');
    await userEvent.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith('World');
  });

  it('Escape викликає onCancel', async () => {
    const onCancel = vi.fn();
    render(<InlineEditCell value="Hello" onCommit={vi.fn()} onCancel={onCancel} />);
    const input = screen.getByRole('textbox');
    input.focus();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });

  it('saving=true показує spinner і disable input', () => {
    render(<InlineEditCell value="x" saving onCommit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByLabelText('Збереження')).toBeInTheDocument();
  });

  it('кнопки "Зберегти" і "Скасувати" мають aria-label і type=button', () => {
    render(<InlineEditCell value="x" onCommit={vi.fn()} onCancel={vi.fn()} />);
    const saveBtn = screen.getByRole('button', { name: 'Зберегти' });
    const cancelBtn = screen.getByRole('button', { name: 'Скасувати' });
    expect(saveBtn).toHaveAttribute('type', 'button');
    expect(cancelBtn).toHaveAttribute('type', 'button');
  });

  it('клік "Зберегти" викликає onCommit', async () => {
    const onCommit = vi.fn();
    render(<InlineEditCell value="Hi" onCommit={onCommit} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    expect(onCommit).toHaveBeenCalledWith('Hi');
  });

  it('клік "Скасувати" викликає onCancel', async () => {
    const onCancel = vi.fn();
    render(<InlineEditCell value="Hi" onCommit={vi.fn()} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: 'Скасувати' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('type="number" створює numeric input', () => {
    render(<InlineEditCell value="42" type="number" onCommit={vi.fn()} onCancel={vi.fn()} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(input.type).toBe('number');
  });

  it('type="date" рендериться без помилок (попри select()-guard)', () => {
    expect(() =>
      render(
        <InlineEditCell value="2026-05-25" type="date" onCommit={vi.fn()} onCancel={vi.fn()} />,
      ),
    ).not.toThrow();
  });
});

describe('InlineViewCell', () => {
  it('рендерить children коли enabled=true', () => {
    render(
      <InlineViewCell value="Hello" onClick={vi.fn()}>
        <span>Контент</span>
      </InlineViewCell>,
    );
    expect(screen.getByText('Контент')).toBeInTheDocument();
  });

  it('має role=button і tabIndex=0', () => {
    render(<InlineViewCell value="x" onClick={vi.fn()} />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('tabindex', '0');
  });

  it('aria-label містить value за замовчуванням', () => {
    render(<InlineViewCell value="Hello" onClick={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Редагувати: Hello');
  });

  it('aria-label = "Редагувати" коли value порожнє', () => {
    render(<InlineViewCell value="" onClick={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Редагувати');
  });

  it('кастомний ariaLabel переважає default', () => {
    render(<InlineViewCell value="x" ariaLabel="Редагувати дедлайн" onClick={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Редагувати дедлайн');
  });

  it('Enter активує onClick', async () => {
    const onClick = vi.fn();
    render(<InlineViewCell value="x" onClick={onClick} />);
    const btn = screen.getByRole('button');
    btn.focus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalled();
  });

  it('Space активує onClick і preventDefault (не скролить сторінку)', async () => {
    const onClick = vi.fn();
    render(<InlineViewCell value="x" onClick={onClick} />);
    const btn = screen.getByRole('button');
    btn.focus();
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalled();
  });

  it('enabled=false не рендерить інтерактивний span', () => {
    render(
      <InlineViewCell value="Hello" enabled={false} onClick={vi.fn()}>
        <span>Контент</span>
      </InlineViewCell>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Контент')).toBeInTheDocument();
  });
});
