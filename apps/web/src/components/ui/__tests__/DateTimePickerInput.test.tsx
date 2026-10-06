import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, afterEach } from 'vitest';
import { DateTimePickerInput } from '../datetime-picker-input';

// Попап рендериться порталом у document.body, а <Modal> слухає Escape на document
// (bubble). До правки Escape з відкритим попапом закривав усю модалку-батька.
describe('DateTimePickerInput — Escape закриває лише попап', () => {
  const calendar = () => document.querySelector('.rdp-root');
  const modalEscape = vi.fn();
  // Імітація Modal: той самий document-level bubble-listener, що у modal.tsx.
  const modalListener = (e: KeyboardEvent) => {
    if (e.key === 'Escape') modalEscape();
  };

  afterEach(() => {
    document.removeEventListener('keydown', modalListener);
    modalEscape.mockClear();
  });

  it('перший Escape закриває попап і не доходить до Modal; другий — доходить', async () => {
    const user = userEvent.setup();
    document.addEventListener('keydown', modalListener);
    render(<DateTimePickerInput value="" onChange={vi.fn()} />);
    const input = screen.getByPlaceholderText('ДД.ММ.РРРР ГГ:ХХ');
    await user.click(input);
    expect(calendar()).not.toBeNull();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(calendar()).toBeNull();
    expect(modalEscape).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(modalEscape).toHaveBeenCalledTimes(1);
  });

  it('Escape з фокусом у <select> попапа (поза інпутом) теж закриває лише попап', async () => {
    const user = userEvent.setup();
    document.addEventListener('keydown', modalListener);
    render(<DateTimePickerInput value="" onChange={vi.fn()} />);
    await user.click(screen.getByPlaceholderText('ДД.ММ.РРРР ГГ:ХХ'));
    const select = document.querySelector('select');
    expect(select).not.toBeNull();

    fireEvent.keyDown(select as HTMLSelectElement, { key: 'Escape' });
    expect(calendar()).toBeNull();
    expect(modalEscape).not.toHaveBeenCalled();
  });

  it('інші клавіші не перехоплюються', async () => {
    const user = userEvent.setup();
    const onKey = vi.fn();
    document.addEventListener('keydown', onKey);
    render(<DateTimePickerInput value="" onChange={vi.fn()} />);
    const input = screen.getByPlaceholderText('ДД.ММ.РРРР ГГ:ХХ');
    await user.click(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(calendar()).not.toBeNull();
    expect(onKey).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', onKey);
  });
});
