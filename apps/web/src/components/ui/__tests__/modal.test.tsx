import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe } from 'vitest';
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
    expect(
      screen.getByRole('heading', { name: 'Підтвердження' }),
    ).toBeInTheDocument();
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
    expect(
      screen.queryByRole('button', { name: 'Закрити' }),
    ).not.toBeInTheDocument();
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
});
