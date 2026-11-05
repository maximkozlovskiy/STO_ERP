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
import { useState } from 'react';
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

// Повернення фокуса після закриття (TECH-DEBT §8 L697, вікно вибору товарів у формі правила
// ціноутворення). Поле пошуку з `autoFocus` брало фокус на коміті, ДО ефекту пастки, і пастка
// запам'ятовувала як «елемент до відкриття» саме його. Після Escape панель зникала разом із полем,
// і фокус падав на <body>, а не на «Додати товар».
//
// Mutation-verify (2026-11-05): запам'ятовувати `document.activeElement` в ефекті, а не в рендері
// → падають «Escape у вкладеній» і «змонтована відкритою»; умова відновлення лише
// `container.contains(activeElement)` (без «фокус загубився») → падають ті самі два; відновлювати
// завжди → падає «чужий фокус не відбирається»; прибрати запасний шлях на нижню пастку → падає
// «відкривача вже немає».
describe('Modal — повернення фокуса після закриття', () => {
  function RuleForm({ mountPicker = false, hideOpener = false }) {
    const [picker, setPicker] = useState(false);
    const pickerModal = (
      <Modal open={picker} onClose={() => setPicker(false)} title="Оберіть товар">
        <input aria-label="Пошук товару" autoFocus />
        <button type="button">Готово</button>
      </Modal>
    );
    return (
      <>
        <button type="button">Кнопка сторінки</button>
        <Modal open onClose={vi.fn()} title="Нове правило">
          <input aria-label="Назва правила" />
          {!(hideOpener && picker) && (
            <button type="button" onClick={() => setPicker(true)}>
              Додати товар
            </button>
          )}
        </Modal>
        {mountPicker ? picker && pickerModal : pickerModal}
      </>
    );
  }

  it('Escape у вкладеній: фокус спершу в пошуку, потім повертається на «Додати товар»', async () => {
    const user = userEvent.setup();
    render(<RuleForm />);
    await user.click(screen.getByRole('button', { name: 'Додати товар' }));
    const search = await screen.findByLabelText('Пошук товару');
    await waitFor(() => expect(search).toHaveFocus());
    await user.keyboard('4820000000000');
    expect(search).toHaveValue('4820000000000');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByLabelText('Пошук товару')).toBeNull());
    expect(screen.getByRole('button', { name: 'Додати товар' })).toHaveFocus();
  });

  it('змонтована одразу відкритою: Tab циклить у ній, Escape повертає на відкривача', async () => {
    const user = userEvent.setup();
    render(<RuleForm mountPicker />);
    await user.click(screen.getByRole('button', { name: 'Додати товар' }));
    const picker = await screen.findByRole('dialog', { name: 'Оберіть товар' });
    await waitFor(() => expect(screen.getByLabelText('Пошук товару')).toHaveFocus());
    for (let i = 0; i < 5; i++) {
      await user.tab();
      expect(picker).toContainElement(document.activeElement as HTMLElement);
    }

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Оберіть товар' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Додати товар' })).toHaveFocus();
  });

  // Mutation-verify (2026-11-05, review): запасний шлях на перший фокусований елемент нижньої
  // (`focusablesIn(lower)[0]`) замість її точки входу → фокус на «×» шапки, Enter закрив би форму
  // з незбереженим — падає перевірка «Назва правила».
  it('відкривача вже немає в документі — фокус у точку входу нижньої модалки, не на <body> і не на «×»', async () => {
    const user = userEvent.setup();
    render(<RuleForm hideOpener />);
    await user.click(screen.getByRole('button', { name: 'Додати товар' }));
    await waitFor(() => expect(screen.getByLabelText('Пошук товару')).toHaveFocus());

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByLabelText('Пошук товару')).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Нове правило' })).toContainElement(
      document.activeElement as HTMLElement,
    );
    expect(screen.getByLabelText('Назва правила')).toHaveFocus();
  });

  it('чужий фокус не відбирається: поле поза вікном, що взяло фокус, його тримає', async () => {
    const user = userEvent.setup();
    function Page() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Відкрити
          </button>
          <input aria-label="Поле сторінки" />
          <Modal open={open} onClose={() => setOpen(false)} title="Вікно">
            <input aria-label="Поле вікна" />
            <button type="button" onClick={() => setOpen(false)}>
              Закрити й перейти
            </button>
          </Modal>
        </>
      );
    }
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'Відкрити' }));
    await waitFor(() => expect(screen.getByLabelText('Поле вікна')).toHaveFocus());

    fireEvent.click(screen.getByRole('button', { name: 'Закрити й перейти' }));
    screen.getByLabelText('Поле сторінки').focus();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Вікно' })).toBeNull());
    expect(screen.getByLabelText('Поле сторінки')).toHaveFocus();
  });
});
