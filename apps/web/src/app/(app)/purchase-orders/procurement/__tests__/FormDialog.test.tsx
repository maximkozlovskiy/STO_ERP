import { act, render, screen } from '@testing-library/react';
import { it, expect, describe, vi } from 'vitest';
import { FormDialog } from '../FormDialog';

// Повторне надсилання, поки запит іде (code-review 2026-10-21): кнопка стає `loading` лише після
// ре-рендеру, а Ctrl+Enter (Modal onSubmit) її взагалі не питає — без синхронного прапорця два входи
// в одному такті слали б два POST (два списки, дві ручні позиції, друге розділення).
// Два native `.click()` поспіль у ОДНОМУ синхронному блоці — обидва до ре-рендеру (див.
// hooks/__tests__/useSubmitGuard.test.tsx, чому не userEvent).
describe('FormDialog', () => {
  it('другий вхід, поки запит іде, нічого не надсилає', async () => {
    let finish: () => void = () => undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    render(
      <FormDialog
        open
        onClose={vi.fn()}
        title="Новий список"
        submitLabel="Створити"
        onSubmit={onSubmit}
      >
        <span>поля</span>
      </FormDialog>,
    );
    const btn = screen.getByRole('button', { name: 'Створити' });
    act(() => {
      btn.click();
      btn.click();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    act(() => btn.click());
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('помилка перевірки — запиту немає, текст у діалозі', () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(
      <FormDialog
        open
        onClose={vi.fn()}
        title="Новий список"
        submitLabel="Створити"
        validate={() => 'Вкажіть назву'}
        onSubmit={onSubmit}
      >
        <span>поля</span>
      </FormDialog>,
    );
    act(() => screen.getByRole('button', { name: 'Створити' }).click());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Вкажіть назву')).toBeInTheDocument();
  });
});
