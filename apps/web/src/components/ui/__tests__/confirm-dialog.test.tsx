import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';
import { ConfirmDialog } from '../confirm-dialog';

/**
 * ConfirmDialog must NOT re-introduce the `if (!open) return null` anti-pattern.
 * It relies on Modal + useAnimatedPresence to keep DOM alive during exit anim,
 * so closing the dialog should leave the modal in the DOM until exit completes.
 */
describe('ConfirmDialog', () => {
  it('не рендерить контент якщо open=false (Modal returns null when !visible)', () => {
    render(<ConfirmDialog open={false} title="Підтвердити" message="Точно?" />);
    expect(screen.queryByText('Точно?')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('рендерить title, message, та обидві кнопки коли open=true', () => {
    render(<ConfirmDialog open title="Видалити запис" message="Цю дію не можна скасувати" />);
    expect(screen.getByRole('heading', { name: 'Видалити запис' })).toBeInTheDocument();
    expect(screen.getByText('Цю дію не можна скасувати')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Так' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeInTheDocument();
  });

  it('кастомні confirmLabel/cancelLabel рендеряться замість дефолтних', () => {
    render(
      <ConfirmDialog
        open
        title="Архівувати?"
        message="x"
        confirmLabel="Архівувати"
        cancelLabel="Не зараз"
      />,
    );
    expect(screen.getByRole('button', { name: 'Архівувати' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Не зараз' })).toBeInTheDocument();
  });

  it('variant="destructive" застосовує destructive variant до confirm-кнопки', () => {
    render(
      <ConfirmDialog
        open
        title="Видалити"
        message="x"
        confirmLabel="Видалити"
        variant="destructive"
      />,
    );
    const btn = screen.getByRole('button', { name: 'Видалити' });
    // destructive variant використовує клас destructive у Button компоненті
    expect(btn.className).toMatch(/destructive/);
  });

  it('клік на confirm викликає onConfirm', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open title="x" message="y" onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Так' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('клік на cancel викликає onCancel', async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="x" message="y" onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: 'Скасувати' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Escape викликає onCancel (через Modal)', async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="x" message="y" onCancel={onCancel} />);
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });

  it('onCancel НЕ заданий → Modal onClose = noop, нічого не падає при Escape', async () => {
    render(<ConfirmDialog open title="x" message="y" />);
    // не має кинути undefined-call
    await expect(userEvent.keyboard('{Escape}')).resolves.not.toThrow();
  });

  // ─── Exit animation propagation ────────────────────────────────────────

  describe('exit animation through Modal + useAnimatedPresence', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('open=true → open=false: dialog тримається у DOM ПІД ЧАС exit-анімації, потім видаляється', () => {
      const { rerender } = render(<ConfirmDialog open title="Підтвердити" message="Точно?" />);
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // Закриваємо
      act(() => {
        rerender(<ConfirmDialog open={false} title="Підтвердити" message="Точно?" />);
      });

      // dialog ЩЕ у DOM (exit-анімація триває)
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      // data-state переключений на "closed"
      expect(screen.getByRole('dialog')).toHaveAttribute('data-state', 'closed');

      // Прокручуємо до завершення exit (180ms default)
      act(() => {
        vi.advanceTimersByTime(180);
      });

      // Тепер dialog видалено
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('повторне open=true до завершення exit перериває exit та лишає dialog у DOM', () => {
      const { rerender } = render(<ConfirmDialog open title="Підтвердити" message="Точно?" />);

      // close
      act(() => {
        rerender(<ConfirmDialog open={false} title="Підтвердити" message="Точно?" />);
      });
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('dialog')).toHaveAttribute('data-state', 'closed');

      // Часткове прокручування
      act(() => {
        vi.advanceTimersByTime(80);
      });
      // ще у DOM
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // Reopen ПЕРЕД 180ms
      act(() => {
        rerender(<ConfirmDialog open title="Підтвердити" message="Точно?" />);
      });

      // Прокручуємо повний exit-таймер — dialog НЕ повинен зникнути
      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });
});
