import { render, screen, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe } from 'vitest';
import { ListLoadError } from '../list-load-error';

// Смуга «список не завантажився» (рішення власника 2026-10-09): збій запиту списку раніше
// виглядав як «нічого не знайдено» — вкладки каси, залишків, рухів складу й оплат не читали
// помилку запиту взагалі.
describe('ListLoadError', () => {
  it('без помилки нічого не рендерить', () => {
    const { container } = render(<ListLoadError error={null} onRetry={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('показує текст помилки сервера як alert', () => {
    render(<ListLoadError error={new Error('Невірна дата у відборі')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Невірна дата у відборі');
  });

  it('помилка без тексту (не Error) → загальне повідомлення українською', () => {
    render(<ListLoadError error={{ status: 500 }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Не вдалося завантажити список');
  });

  it('«Повторити» кличе onRetry; без onRetry кнопки немає', () => {
    const onRetry = vi.fn();
    const { unmount } = render(<ListLoadError error={new Error('x')} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();
    render(<ListLoadError error={new Error('x')} />);
    expect(screen.queryByRole('button', { name: 'Повторити' })).not.toBeInTheDocument();
  });
});
