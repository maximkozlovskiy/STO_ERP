import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import GlobalError from '../error';

describe('GlobalError (app/error.tsx — Next.js App Router error boundary)', () => {
  beforeEach(() => {
    // Заглушити console.error щоб не засмічувати тест-вивід — компонент свідомо
    // логує помилку через useEffect.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('рендерить кириличний заголовок "Виникла помилка"', () => {
    const error = new Error('Boom');
    render(<GlobalError error={error} reset={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Виникла помилка' })).toBeInTheDocument();
  });

  it('показує error.message якщо вона присутня', () => {
    const error = new Error('Конкретне повідомлення');
    render(<GlobalError error={error} reset={() => {}} />);
    expect(screen.getByText('Конкретне повідомлення')).toBeInTheDocument();
  });

  it('показує кириличний fallback коли error.message порожній', () => {
    const error = new Error('');
    render(<GlobalError error={error} reset={() => {}} />);
    expect(screen.getByText('Щось пішло не так. Спробуйте оновити сторінку.')).toBeInTheDocument();
  });

  it('викликає reset() при кліку на "Спробувати знову"', async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<GlobalError error={new Error('Boom')} reset={reset} />);
    await user.click(screen.getByRole('button', { name: 'Спробувати знову' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('рендерить кнопку "На головну" що навігує на /dashboard', () => {
    render(<GlobalError error={new Error('Boom')} reset={() => {}} />);
    expect(screen.getByRole('button', { name: 'На головну' })).toBeInTheDocument();
  });

  it('логує помилку у console.error через useEffect', () => {
    const spy = vi.spyOn(console, 'error');
    const error = new Error('TestBoom');
    render(<GlobalError error={error} reset={() => {}} />);
    expect(spy).toHaveBeenCalledWith('[GlobalError]', error);
  });

  it('приймає Error з опціональним digest (Next.js серверна помилка)', () => {
    // Регрес-тест Bug #206: тип має дозволяти `error.digest`. Якщо TS-тип
    // регресне на bare `Error`, цей файл перестане компілюватись.
    const error: Error & { digest?: string } = Object.assign(new Error('SSR fail'), {
      digest: 'abc123',
    });
    render(<GlobalError error={error} reset={() => {}} />);
    expect(screen.getByText('SSR fail')).toBeInTheDocument();
  });

  it('декоративна SVG-іконка має aria-hidden="true"', () => {
    const { container } = render(<GlobalError error={new Error('X')} reset={() => {}} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });
});
