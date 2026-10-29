// Початковий фокус вікна — на першому полі, не на «×» шапки (UX-огляд 2026-10-29: пошук послуги,
// новий платіж, «Внести» в касі, нова задача, рядки роботи й товару). Поле з попапом на фокус
// (дата) пропускається; `autoFocus` і `data-autofocus` мають перевагу; вікно без полів — як раніше.
// Escape у поповері «Колонки» закриває лише його (шар `useEscapeLayer`), біля лівого краю він
// розкривається праворуч від кнопки.
//
// jsdom не має розкладки (`offsetParent` завжди null) — тут він підмінений: видимий кожен елемент.
//
// Mutation-verify (2026-10-29): прибрати пошук FIELD у useFocusTrap → падає «перше поле»; прибрати
// `data-no-autofocus` у DatePickerInput → падає «дата пропускається»; прибрати useEscapeLayer у
// ColumnsDropdown → падає «Escape у поповері».
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeAll, afterAll } from 'vitest';
import { Modal } from '../modal';
import { DatePickerInput } from '../date-picker-input';
import { ColumnsDropdown } from '../columns-dropdown';

const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      return document.body;
    },
  });
});
afterAll(() => {
  if (desc) Object.defineProperty(HTMLElement.prototype, 'offsetParent', desc);
});

describe('Modal — початковий фокус', () => {
  it('перше поле введення, а не «×» шапки', async () => {
    render(
      <Modal open onClose={vi.fn()} title="Нова задача">
        <input type="checkbox" aria-label="прапорець" />
        <input aria-label="Назва" />
        <textarea aria-label="Опис" />
      </Modal>,
    );
    await waitFor(() => expect(screen.getByLabelText('Назва')).toHaveFocus());
  });

  it('поле дати (календар на фокус) пропускається — фокус на наступному полі', async () => {
    render(
      <Modal open onClose={vi.fn()} title="Новий платіж">
        <DatePickerInput value="2026-10-29" onChange={vi.fn()} />
        <input aria-label="Сума" />
      </Modal>,
    );
    await waitFor(() => expect(screen.getByLabelText('Сума')).toHaveFocus());
  });

  it('autoFocus і data-autofocus мають перевагу перед першим полем', async () => {
    const { unmount } = render(
      <Modal open onClose={vi.fn()} title="Внести готівку">
        <input aria-label="Перше" />
        <input aria-label="Сума" autoFocus />
      </Modal>,
    );
    await waitFor(() => expect(screen.getByLabelText('Сума')).toHaveFocus());
    unmount();

    render(
      <Modal open onClose={vi.fn()} title="Пошук послуги">
        <input aria-label="Фільтр" />
        <input aria-label="Пошук" data-autofocus="" />
      </Modal>,
    );
    await waitFor(() => expect(screen.getByLabelText('Пошук')).toHaveFocus());
  });

  it('без полів — перший фокусований елемент (як раніше)', async () => {
    render(
      <Modal open onClose={vi.fn()} title="Підтвердження">
        <button type="button">Так</button>
      </Modal>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Закрити' })).toHaveFocus());
  });
});

describe('ColumnsDropdown — Escape і край екрана', () => {
  const columns = [
    { key: 'a', label: 'Номер' },
    { key: 'b', label: 'Сума' },
  ];

  it('Escape закриває лише поповер «Колонки», вікно під ним лишається', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal open onClose={onClose} title="Картка">
        <ColumnsDropdown columns={columns} visibleKeys={new Set(['a', 'b'])} onToggle={vi.fn()} />
      </Modal>,
    );
    await user.click(screen.getByRole('button', { name: /Налаштувати колонки|колонк/i }));
    expect(screen.getByTestId('columns-popover')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('columns-popover')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('кнопка біля лівого краю (390 px) — поповер розкривається праворуч від неї', () => {
    render(<ColumnsDropdown columns={columns} visibleKeys={new Set(['a'])} onToggle={vi.fn()} />);
    const button = screen.getByRole('button', { name: /колонк/i });
    const host = button.parentElement as HTMLElement;
    host.getBoundingClientRect = () => ({ right: 120 }) as DOMRect;
    fireEvent.click(button);
    expect(screen.getByTestId('columns-popover')).toHaveClass('left-0');
    expect(screen.getByTestId('columns-popover')).not.toHaveClass('right-0');

    fireEvent.click(button);
    host.getBoundingClientRect = () => ({ right: 1400 }) as DOMRect;
    fireEvent.click(button);
    expect(screen.getByTestId('columns-popover')).toHaveClass('right-0');
  });
});
