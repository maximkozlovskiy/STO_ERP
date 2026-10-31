import { render, screen, act, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';
import { Modal, AnimatedBody } from '../modal';

describe('Modal', () => {
  it('не рендерить content якщо open=false', () => {
    render(
      <Modal open={false} onClose={vi.fn()} title="Тест">
        Контент
      </Modal>,
    );
    expect(screen.queryByText('Контент')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('рендерить контент якщо open=true', () => {
    render(
      <Modal open onClose={vi.fn()} title="Тест">
        Контент модалки
      </Modal>,
    );
    expect(screen.getByText('Контент модалки')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  // Модалка, яку монтують ОДРАЗУ відкритою (`{x && <Modal open />}`, картка, відновлена з
  // вкладки), на першому рендері ще не має панелі: портал з'являється лише після `mounted`.
  // Пастка фокуса вмикалась до появи панелі й більше не перезапускалась — фокус лишався на
  // сторінці під модалкою, і Tab ходив по ній (перевірено наживо 2026-10-14).
  // Мутація: `useFocusTrap(panelRef, visible)` без `&& mounted` → обидві перевірки падають.
  it('змонтована одразу відкритою — забирає фокус у панель і тримає Tab у ній', async () => {
    render(
      <>
        <button type="button">Кнопка сторінки</button>
        <Modal open onClose={vi.fn()} title="Тест">
          <button type="button">Дія в модалці</button>
        </Modal>
      </>,
    );
    const dialog = screen.getByRole('dialog');

    expect(dialog.contains(document.activeElement)).toBe(true);

    for (let i = 0; i < 4; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('рендерить title у заголовку', () => {
    render(
      <Modal open onClose={vi.fn()} title="Підтвердження">
        Вміст
      </Modal>,
    );
    expect(screen.getByRole('heading', { name: 'Підтвердження' })).toBeInTheDocument();
  });

  it('рендерить description під title', () => {
    render(
      <Modal open onClose={vi.fn()} title="Дія" description="Опис дії">
        Вміст
      </Modal>,
    );
    expect(screen.getByText('Опис дії')).toBeInTheDocument();
  });

  it('виклик onClose при натисканні Escape', async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Тест">
        Вміст
      </Modal>,
    );
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  // Стек шарів Escape (техборг §15.12): вікно над вікном — Escape закриває лише верхнє. Раніше
  // кожен Modal слухав Escape сам, і власник рятувався прапорцем «вкладене відкрито».
  describe('Escape у вкладеному вікні', () => {
    function Nested({ onOuterClose }: { onOuterClose: () => void }) {
      const [inner, setInner] = useState(true);
      // Нова стрілка onClose на кожен рендер — як у карток; ререндер власника не міняє порядок.
      return (
        <Modal open onClose={() => onOuterClose()} title="Картка">
          <Modal open={inner} onClose={() => setInner(false)} title="Вибір">
            Вкладене
          </Modal>
        </Modal>
      );
    }

    it('перший Escape закриває лише вкладене, другий — картку', async () => {
      const onOuterClose = vi.fn();
      render(<Nested onOuterClose={onOuterClose} />);
      await userEvent.keyboard('{Escape}');
      expect(onOuterClose).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: 'Вибір' })).toHaveAttribute('data-state', 'closed');
      await userEvent.keyboard('{Escape}');
      expect(onOuterClose).toHaveBeenCalledTimes(1);
    });

    it('два Escape підряд без пауз (рендер між ними) — так само по одному вікну', () => {
      const onOuterClose = vi.fn();
      render(<Nested onOuterClose={onOuterClose} />);
      act(() => {
        fireEvent.keyDown(document.body, { key: 'Escape' });
      });
      expect(onOuterClose).not.toHaveBeenCalled();
      act(() => {
        fireEvent.keyDown(document.body, { key: 'Escape' });
      });
      expect(onOuterClose).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Ctrl+Enter → onSubmit (Feature 6: keyboard в модалках) ────────────────
  //
  // keyboardShortcutsEnabled приходить з useUiFeatures; у jsdom без токена
  // повертаються DEFAULTS (keyboardShortcutsEnabled: true), тож хендлер активний.

  it('Ctrl+Enter викликає onSubmit рівно один раз', async () => {
    const onSubmit = vi.fn();
    render(
      <Modal open onClose={vi.fn()} onSubmit={onSubmit} title="Тест">
        <input aria-label="поле" />
      </Modal>,
    );
    const input = screen.getByLabelText('поле');
    input.focus();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Cmd+Enter (metaKey) також викликає onSubmit', async () => {
    const onSubmit = vi.fn();
    render(
      <Modal open onClose={vi.fn()} onSubmit={onSubmit} title="Тест">
        <input aria-label="поле" />
      </Modal>,
    );
    screen.getByLabelText('поле').focus();
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Enter без модифікатора НЕ викликає onSubmit', async () => {
    const onSubmit = vi.fn();
    render(
      <Modal open onClose={vi.fn()} onSubmit={onSubmit} title="Тест">
        <input aria-label="поле" />
      </Modal>,
    );
    screen.getByLabelText('поле').focus();
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('без onSubmit Ctrl+Enter — no-op (не кидає)', async () => {
    render(
      <Modal open onClose={vi.fn()} title="Тест">
        <input aria-label="поле" />
      </Modal>,
    );
    screen.getByLabelText('поле').focus();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    // Немає падіння — тест зелений, якщо ми дійшли сюди.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  // Bug #638 (audit 2026-09-05): дві вкладені модалки (create + picker поверх нього)
  // ОБИДВІ слухають document на keydown. Без scope-перевірки `panelRef.contains(target)`
  // Ctrl+Enter із фокусом у ДИТИНІ спрацював би ДВІЧІ — раз у дитині, раз у батькові
  // (батько теж бачить подію на document) → подвійний submit. panelRef має відсікти
  // батька: target у дитячій панелі не належить батьківській панелі.
  it('Ctrl+Enter у вкладеній модалці НЕ подвоює submit — спрацьовує лише активна панель', async () => {
    const parentSubmit = vi.fn();
    const childSubmit = vi.fn();
    render(
      <>
        <Modal open onClose={vi.fn()} onSubmit={parentSubmit} title="Батьківська">
          <input aria-label="поле-батька" />
        </Modal>
        <Modal open onClose={vi.fn()} onSubmit={childSubmit} title="Дитяча">
          <input aria-label="поле-дитини" />
        </Modal>
      </>,
    );
    // Фокус у дитячій панелі → Ctrl+Enter.
    screen.getByLabelText('поле-дитини').focus();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(childSubmit).toHaveBeenCalledTimes(1);
    expect(parentSubmit).not.toHaveBeenCalled();
  });

  // Review 2026-10-13: пастки фокуса обох модалок слухають document, нижня чує Tab першою.
  // Вона вважала фокус у верхній модалці «втечею» і тягла його на свій край, верхня — на свій:
  // Tab у вкладеній модалці завжди стрибав на її першу кнопку, решта була недосяжна.
  describe('Tab у вкладеній модалці', () => {
    // jsdom не рахує розмітку: offsetParent завжди null, і пастка вважала б усе невидимим.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
        configurable: true,
        get(this: HTMLElement) {
          return this.parentNode;
        },
      });
    });
    afterEach(() => {
      if (original) Object.defineProperty(HTMLElement.prototype, 'offsetParent', original);
    });

    // Пастка вмикається на ВІДКРИТТІ вже змонтованої модалки (як у застосунку), тому спершу
    // рендер закритих, потім відкриття: нижня, за нею верхня.
    const nested = (parentOpen: boolean, childOpen: boolean) => (
      <>
        <Modal open={parentOpen} onClose={vi.fn()} title="Батьківська">
          <input aria-label="поле-батька" />
        </Modal>
        <Modal open={childOpen} onClose={vi.fn()} title="Дитяча">
          <input aria-label="перше" />
          <input aria-label="друге" />
          <input aria-label="останнє" />
        </Modal>
      </>
    );
    const renderNested = () => {
      const { rerender } = render(nested(false, false));
      rerender(nested(true, false));
      rerender(nested(true, true));
    };

    it('Tab іде до наступного поля верхньої модалки, а не стрибає на її першу кнопку', async () => {
      const user = userEvent.setup();
      renderNested();
      screen.getByLabelText('перше').focus();

      await user.tab();
      expect(screen.getByLabelText('друге')).toHaveFocus();
      await user.tab({ shift: true });
      expect(screen.getByLabelText('перше')).toHaveFocus();
    });

    it('з останнього елемента верхньої модалки Tab повертає на її перший, не в нижню', async () => {
      const user = userEvent.setup();
      renderNested();
      const child = screen.getByRole('dialog', { name: 'Дитяча' });
      screen.getByLabelText('останнє').focus();

      await user.tab();
      expect(child).toContainElement(document.activeElement as HTMLElement);
      expect(screen.getByLabelText('останнє')).not.toHaveFocus();
      expect(screen.getByLabelText('поле-батька')).not.toHaveFocus();
    });

    it('одна модалка: фокус, що опинився поза панеллю, Tab повертає всередину', async () => {
      const user = userEvent.setup();
      const single = (open: boolean) => (
        <>
          <button type="button">фон</button>
          <Modal open={open} onClose={vi.fn()} title="Одна">
            <input aria-label="поле" />
          </Modal>
        </>
      );
      const { rerender } = render(single(false));
      rerender(single(true));
      screen.getByRole('button', { name: 'фон' }).focus();

      await user.tab();
      expect(screen.getByRole('dialog', { name: 'Одна' })).toContainElement(
        document.activeElement as HTMLElement,
      );
    });
  });

  it('Ctrl+Enter із фокусом у батьківській панелі не чіпає дитячу', async () => {
    const parentSubmit = vi.fn();
    const childSubmit = vi.fn();
    render(
      <>
        <Modal open onClose={vi.fn()} onSubmit={parentSubmit} title="Батьківська">
          <input aria-label="поле-батька" />
        </Modal>
        <Modal open onClose={vi.fn()} onSubmit={childSubmit} title="Дитяча">
          <input aria-label="поле-дитини" />
        </Modal>
      </>,
    );
    screen.getByLabelText('поле-батька').focus();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(parentSubmit).toHaveBeenCalledTimes(1);
    expect(childSubmit).not.toHaveBeenCalled();
  });

  it('виклик onClose при кліку на backdrop', async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Тест">
        Вміст
      </Modal>,
    );
    // Backdrop — це div з класом bg-black/40 (другий child всередині dialog)
    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.querySelector('div.bg-black\\/40');
    expect(backdrop).toBeTruthy();
    await userEvent.click(backdrop as Element);
    expect(onClose).toHaveBeenCalled();
  });

  it('кнопка закриття (X) має aria-label "Закрити" і викликає onClose', async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Тест">
        Вміст
      </Modal>,
    );
    const closeBtn = screen.getByRole('button', { name: 'Закрити' });
    await userEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('hideClose=true приховує кнопку закриття', () => {
    render(
      <Modal open onClose={vi.fn()} title="Тест" hideClose>
        Вміст
      </Modal>,
    );
    expect(screen.queryByRole('button', { name: 'Закрити' })).not.toBeInTheDocument();
  });

  it('footer рендерить кнопки', () => {
    render(
      <Modal
        open
        onClose={vi.fn()}
        title="Підтвердити"
        footer={
          <>
            <button>Скасувати</button>
            <button>Підтвердити</button>
          </>
        }
      >
        Ви впевнені?
      </Modal>,
    );
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Підтвердити' })).toBeInTheDocument();
  });

  it('має aria-modal="true"', () => {
    render(
      <Modal open onClose={vi.fn()} title="Тест">
        Вміст
      </Modal>,
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });

  // ─── size prop — max-width per size (Bug #196) ───────────────────────────────

  // panel = third div всередині dialog (backdrop = другий, panel — наступний sibling)
  // надійніше — знайти елемент з inline-style maxWidth, який є саме на panel
  function getPanel(): HTMLElement {
    const dialog = screen.getByRole('dialog');
    const panel = dialog.querySelector('[style*="max-width"]') as HTMLElement | null;
    if (!panel) throw new Error('Modal panel with inline max-width not found');
    return panel;
  }

  it('size="md" (default) виставляє max-width: 512px', () => {
    render(
      <Modal open onClose={vi.fn()} title="Default">
        Вміст
      </Modal>,
    );
    expect(getPanel().style.maxWidth).toBe('512px');
  });

  it('size="sm" виставляє max-width: 384px', () => {
    render(
      <Modal open onClose={vi.fn()} title="Small" size="sm">
        Вміст
      </Modal>,
    );
    expect(getPanel().style.maxWidth).toBe('384px');
  });

  it('size="lg" виставляє max-width: 672px (employees/catalog works/stock-documents)', () => {
    render(
      <Modal open onClose={vi.fn()} title="Large" size="lg">
        Вміст
      </Modal>,
    );
    expect(getPanel().style.maxWidth).toBe('672px');
  });

  // Рішення власника 2026-10-12: картки редагування елементів довідників (контрагент, товар,
  // співробітник) трохи ширші за lg і НЕ міняють розмір вікна при переході між вкладками.
  // Mutation-verify: прибрати `fixedHeight && FIXED_HEIGHT_CLASS` → кейс зі сталою висотою падає.
  it('size="wide" виставляє max-width: 768px (картки контрагента, товару, співробітника)', () => {
    render(
      <Modal open onClose={vi.fn()} title="Wide" size="wide">
        Вміст
      </Modal>,
    );
    expect(getPanel().style.maxWidth).toBe('768px');
  });

  it('fixedHeight — вікно сталої висоти (760px, не вище 90% екрана); без нього висота за вмістом', () => {
    const { unmount } = render(
      <Modal open onClose={vi.fn()} title="Fixed" fixedHeight>
        Вміст
      </Modal>,
    );
    expect(getPanel().className).toContain('h-[min(90dvh,760px)]');
    // тіло лишається прокручуваним і займає решту вікна
    expect(getPanel().querySelector('.flex-1.min-h-0.overflow-y-auto')).not.toBeNull();
    unmount();
    render(
      <Modal open onClose={vi.fn()} title="Auto">
        Вміст
      </Modal>,
    );
    expect(getPanel().className).not.toContain('h-[min(');
  });

  // The work order card is full-height: its tabs must not resize the window either, but a 760px
  // cap would shrink the main tab on tall screens. Mutation-verify: drop the 'full' branch → fails.
  it('fixedHeight="full" keeps the panel at 90dvh, without the 760px cap', () => {
    render(
      <Modal open onClose={vi.fn()} title="Full" fixedHeight="full">
        Body
      </Modal>,
    );
    expect(getPanel().className).toContain('h-[90dvh]');
    expect(getPanel().className).not.toContain('h-[min(');
  });

  it('size="xl" виставляє max-width: 896px (work-orders/catalog goods/purchase-orders/pricing-rules)', () => {
    render(
      <Modal open onClose={vi.fn()} title="Extra large" size="xl">
        Вміст
      </Modal>,
    );
    expect(getPanel().style.maxWidth).toBe('896px');
  });

  it('size="full" виставляє max-width: 95vw', () => {
    render(
      <Modal open onClose={vi.fn()} title="Full" size="full">
        Вміст
      </Modal>,
    );
    expect(getPanel().style.maxWidth).toBe('95vw');
  });

  // Картка документа на телефоні: «100vw − 216px» (ширина бічного меню, якого там немає) давало
  // 174px при 390px. Нижня межа 768px — вужчий екран обмежує `w-full` у контейнері з відступами.
  it('size="content": без бічного меню, але не вужче 768px (телефон — уся ширина)', () => {
    render(
      <Modal open onClose={vi.fn()} title="Документ" size="content">
        Вміст
      </Modal>,
    );
    const maxWidth = getPanel().style.maxWidth;
    expect(maxWidth).toContain('100vw - 216px');
    expect(maxWidth).toMatch(/^max\(.*768px\)$/);
  });

  // ─── Animation integration з useAnimatedPresence (data-state/data-animate) ──

  describe('exit animation through useAnimatedPresence', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('root має data-animate marker і data-state="open" коли open=true', () => {
      render(
        <Modal open onClose={vi.fn()} title="Animated">
          Вміст
        </Modal>,
      );
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('data-animate');
      expect(dialog).toHaveAttribute('data-state', 'open');
    });

    it('backdrop має data-backdrop marker як direct child root-у (для CSS selector "> [data-backdrop]")', () => {
      render(
        <Modal open onClose={vi.fn()} title="Backdrop">
          Вміст
        </Modal>,
      );
      const dialog = screen.getByRole('dialog');
      const backdrop = dialog.querySelector(':scope > [data-backdrop]');
      expect(backdrop).toBeTruthy();
    });

    it('open=true → open=false: dialog тримається у DOM з data-state="closed" протягом exit-анімації', () => {
      const { rerender } = render(
        <Modal open onClose={vi.fn()} title="Exit">
          Контент
        </Modal>,
      );
      expect(screen.getByRole('dialog')).toHaveAttribute('data-state', 'open');

      // Закриваємо
      act(() => {
        rerender(
          <Modal open={false} onClose={vi.fn()} title="Exit">
            Контент
          </Modal>,
        );
      });

      // Dialog ще у DOM з data-state="closed"
      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveAttribute('data-state', 'closed');
      expect(screen.getByText('Контент')).toBeInTheDocument();

      // Прокручуємо до завершення default exit (180ms)
      act(() => {
        vi.advanceTimersByTime(180);
      });

      // Тепер dialog видалено
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByText('Контент')).not.toBeInTheDocument();
    });
  });
});

// ─── AnimatedBody — standalone компонент (Bug #195) ─────────────────────────

describe('AnimatedBody (standalone)', () => {
  it('рендерить children як standalone (поза Modal)', () => {
    render(
      <AnimatedBody className="p-4">
        <p>Інлайн форма</p>
      </AnimatedBody>,
    );
    expect(screen.getByText('Інлайн форма')).toBeInTheDocument();
  });

  it('передає className на inner-елемент', () => {
    const { container } = render(
      <AnimatedBody className="custom-padding bg-secondary">
        <span>x</span>
      </AnimatedBody>,
    );
    const inner = container.querySelector('.custom-padding') as HTMLElement | null;
    expect(inner).toBeTruthy();
    expect(inner?.className).toMatch(/bg-secondary/);
  });

  it('cleanup чистить ResizeObserver і cancelAnimationFrame на unmount (без DOM-mutation після disconnect)', () => {
    // Spy на cancelAnimationFrame щоб впевнитись що pending rAF скасовується
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame');
    // Spy на ResizeObserver.disconnect через мок-клас
    const disconnectSpy = vi.fn();
    const observeSpy = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const origRO = (globalThis as any).ResizeObserver;
    class ROCapture {
      disconnect = disconnectSpy;
      observe = observeSpy;
      unobserve = vi.fn();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = ROCapture;

    const { unmount } = render(
      <AnimatedBody className="p-2">
        <p>Контент</p>
      </AnimatedBody>,
    );

    // observe викликаний на mount
    expect(observeSpy).toHaveBeenCalledTimes(1);

    act(() => {
      unmount();
    });

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    // cancelAnimationFrame викликається тільки якщо rafRef ще не виконався;
    // у jsdom rAF може не виконатися синхронно — тому як мінімум disconnect має спрацювати
    // (захист від DOM-mutation після disconnect/unmount)

    // restore
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = origRO;
    cancelSpy.mockRestore();
  });

  it('використовується всередині Modal через AnimatedBody body (інтеграція)', () => {
    render(
      <Modal open onClose={vi.fn()} title="Тест">
        <div data-testid="modal-children">Тестовий вміст</div>
      </Modal>,
    );
    // Modal-body — AnimatedBody-обгортка, children мають бути доступні
    expect(screen.getByTestId('modal-children')).toBeInTheDocument();
  });

  // ─── fill prop (Bug #336) ──────────────────────────────────────────────────
  //
  // `fill` mode використовується Modal-body для viewport-fill розкладки:
  //   - outer стає flex-1 min-h-0 overflow-y-auto (заповнює простір у flex-col панелі)
  //   - inner отримує лише padding (className)
  //   - JS-height-керування (ResizeObserver + scrollHeight) ВИМКНЕНЕ —
  //     інакше outer.height = inner.scrollHeight ламає flex-розтягування.
  //
  // Без цих тестів regression "fill prop невипадково ввімкнено для standalone
  // використання" або "fill=true все одно створює ResizeObserver" не ловиться.

  describe('fill prop', () => {
    it('fill=true: outer має flex-1 min-h-0 overflow-y-auto (заповнює доступний простір)', () => {
      const { container } = render(
        <AnimatedBody fill className="px-6 py-5">
          <p>Body content</p>
        </AnimatedBody>,
      );
      // outer = root child container
      const outer = container.firstElementChild as HTMLElement;
      expect(outer).toBeTruthy();
      expect(outer.className).toMatch(/flex-1/);
      expect(outer.className).toMatch(/min-h-0/);
      expect(outer.className).toMatch(/overflow-y-auto/);
    });

    it('fill=true: className застосовується на inner div (не на outer)', () => {
      const { container } = render(
        <AnimatedBody fill className="px-6 py-5">
          <p>Body content</p>
        </AnimatedBody>,
      );
      const outer = container.firstElementChild as HTMLElement;
      const inner = outer.firstElementChild as HTMLElement;
      // className має жити лише на inner
      expect(inner.className).toBe('px-6 py-5');
      // outer.className НЕ має містити користувацький className (тільки fill-класи)
      expect(outer.className).not.toMatch(/px-6/);
      expect(outer.className).not.toMatch(/py-5/);
    });

    it('fill=true: НЕ створює ResizeObserver (JS height-керування вимкнене — useEffect early return)', () => {
      // Spy на ResizeObserver constructor через мок-клас
      const constructorSpy = vi.fn();
      const observeSpy = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const origRO = (globalThis as any).ResizeObserver;
      class ROCapture {
        constructor() {
          constructorSpy();
        }
        disconnect = vi.fn();
        observe = observeSpy;
        unobserve = vi.fn();
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).ResizeObserver = ROCapture;

      render(
        <AnimatedBody fill className="px-6 py-5">
          <p>Контент</p>
        </AnimatedBody>,
      );

      // У fill-режимі useEffect має early-return ДО створення ResizeObserver
      expect(constructorSpy).not.toHaveBeenCalled();
      expect(observeSpy).not.toHaveBeenCalled();

      // restore
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).ResizeObserver = origRO;
    });

    it('fill=true: НЕ виставляє inline-style height на outer (flex-розтягування)', () => {
      const { container } = render(
        <AnimatedBody fill className="px-6 py-5">
          <p>Контент</p>
        </AnimatedBody>,
      );
      const outer = container.firstElementChild as HTMLElement;
      // У fill-режимі outer не має inline height — height керується flex
      expect(outer.style.height).toBe('');
      expect(outer.style.transition).toBe('');
    });

    it('fill=false (default): outer має overflow:hidden inline-style (legacy animation mode)', () => {
      const { container } = render(
        <AnimatedBody className="p-4">
          <p>Контент</p>
        </AnimatedBody>,
      );
      const outer = container.firstElementChild as HTMLElement;
      // Legacy режим: outer має style.overflow="hidden" для clip під час animated height
      expect(outer.style.overflow).toBe('hidden');
    });

    it('Modal-body внутрішньо передає fill=true: outer Modal-body має flex-1 min-h-0 overflow-y-auto', () => {
      render(
        <Modal open onClose={vi.fn()} title="Test">
          <div data-testid="content">Modal content</div>
        </Modal>,
      );
      const content = screen.getByTestId('content');
      // Найближчий батьківський div з overflow-y-auto = AnimatedBody outer
      const outer = content.parentElement?.parentElement as HTMLElement;
      expect(outer).toBeTruthy();
      expect(outer.className).toMatch(/flex-1/);
      expect(outer.className).toMatch(/min-h-0/);
      expect(outer.className).toMatch(/overflow-y-auto/);
    });

    it('Modal panel має max-h-[90dvh] + flex flex-col (viewport-fill контракт)', () => {
      render(
        <Modal open onClose={vi.fn()} title="Test">
          <p>Content</p>
        </Modal>,
      );
      const dialog = screen.getByRole('dialog');
      const panel = dialog.querySelector('[style*="max-width"]') as HTMLElement | null;
      expect(panel).toBeTruthy();
      expect(panel!.className).toMatch(/flex/);
      expect(panel!.className).toMatch(/flex-col/);
      // max-h-[90dvh] — обмежує висоту панелі до 90% viewport
      expect(panel!.className).toMatch(/max-h-\[90dvh\]/);
    });
  });
});

// Закриття вкладеного вікна знімало блокування прокрутки сторінки, хоча картка під ним лишалась
// відкритою (TECH-DEBT §15.14): cleanup кожного Modal ставив `overflow = ''`.
describe('Modal — блокування прокрутки сторінки', () => {
  function Nested({ outer, inner }: { outer: boolean; inner: boolean }) {
    return (
      <>
        <Modal open={outer} onClose={vi.fn()} title="Картка">
          Картка
        </Modal>
        <Modal open={inner} onClose={vi.fn()} title="Вибір">
          Вибір
        </Modal>
      </>
    );
  }

  it('закрите вкладене вікно лишає блокування, закрита картка — повертає попередній стиль', () => {
    document.body.style.overflow = 'auto';
    const { rerender } = render(<Nested outer inner />);
    expect(document.body.style.overflow).toBe('hidden');

    rerender(<Nested outer inner={false} />);
    expect(document.body.style.overflow).toBe('hidden');

    rerender(<Nested outer={false} inner={false} />);
    expect(document.body.style.overflow).toBe('auto');
    document.body.style.overflow = '';
  });

  it('вкладене вікно, що лишилось відкритим, тримає блокування після закриття картки', () => {
    const { rerender, unmount } = render(<Nested outer inner />);
    rerender(<Nested outer={false} inner />);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });
});
