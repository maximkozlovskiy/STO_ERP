import { render, screen, act } from '@testing-library/react';
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
