import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe } from 'vitest';
import { DatePickerInput } from '../date-picker-input';

// Календар відкривається на focus і раніше закривався ЛИШЕ кліком поза ним: після
// введення дати з клавіатури попап лишався поверх таблиці (знайдено E2E status-tooltip).
describe('DatePickerInput — закриття календаря з клавіатури', () => {
  const calendar = () => document.querySelector('.rdp-root');

  it('Enter після введення дати закриває календар', async () => {
    const user = userEvent.setup();
    render(<DatePickerInput value="" onChange={vi.fn()} placeholder="ДД.ММ.РРРР" />);
    const input = screen.getByPlaceholderText('ДД.ММ.РРРР');
    await user.click(input);
    expect(calendar()).not.toBeNull();
    await user.keyboard('{Enter}');
    expect(calendar()).toBeNull();
  });

  it('Escape закриває календар і не спливає до батька (модалка лишається)', async () => {
    const user = userEvent.setup();
    const parentKeyDown = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <div onKeyDown={parentKeyDown}>
        <DatePickerInput value="" onChange={vi.fn()} placeholder="ДД.ММ.РРРР" />
      </div>,
    );
    const input = screen.getByPlaceholderText('ДД.ММ.РРРР');
    await user.click(input);
    expect(calendar()).not.toBeNull();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(calendar()).toBeNull();
    expect(parentKeyDown).not.toHaveBeenCalled();
    // Календар уже закритий → наступний Escape належить батькові.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(parentKeyDown).toHaveBeenCalledTimes(1);
  });

  // Справжня <Modal> слухає Escape нативно на document (bubble), а не через React-батька.
  // Календар можна відкрити кнопкою-іконкою — тоді фокус на ній, а не в полі.
  it('Escape при фокусі на кнопці-іконці закриває календар і не доходить до document', async () => {
    const user = userEvent.setup();
    const documentKeyDown = vi.fn();
    document.addEventListener('keydown', documentKeyDown);
    try {
      render(<DatePickerInput value="" onChange={vi.fn()} placeholder="ДД.ММ.РРРР" />);
      const iconButton = screen.getByRole('button', { name: 'Відкрити календар' });
      await user.click(iconButton);
      expect(calendar()).not.toBeNull();
      expect(document.activeElement).toBe(iconButton);
      fireEvent.keyDown(iconButton, { key: 'Escape' });
      expect(calendar()).toBeNull();
      expect(documentKeyDown).not.toHaveBeenCalled();
      // Календар закритий → наступний Escape вже належить модалці.
      fireEvent.keyDown(iconButton, { key: 'Escape' });
      expect(documentKeyDown).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', documentKeyDown);
    }
  });

  it('клік по вже сфокусованому полю після Escape знову відкриває календар', async () => {
    const user = userEvent.setup();
    render(<DatePickerInput value="" onChange={vi.fn()} placeholder="ДД.ММ.РРРР" />);
    const input = screen.getByPlaceholderText('ДД.ММ.РРРР');
    await user.click(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(calendar()).toBeNull();
    expect(document.activeElement).toBe(input);
    await user.click(input);
    expect(calendar()).not.toBeNull();
  });
});
