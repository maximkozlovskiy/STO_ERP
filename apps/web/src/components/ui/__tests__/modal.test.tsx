import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe } from 'vitest';
import { Modal } from '../modal';

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
});
