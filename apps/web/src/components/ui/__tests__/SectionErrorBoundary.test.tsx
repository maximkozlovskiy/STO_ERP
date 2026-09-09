// E3 — SectionErrorBoundary: ізолює краш секції від решти сторінки.
import { render, screen, fireEvent } from '@testing-library/react';
import { it, expect, describe, vi, beforeEach, afterEach } from 'vitest';
import { SectionErrorBoundary } from '../SectionErrorBoundary';

function Boom(): never {
  throw new Error('section crashed');
}

describe('SectionErrorBoundary', () => {
  beforeEach(() => {
    // React логує crash у console.error — глушимо, щоб не засмічувати вивід тесту.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('рендерить дітей коли помилки немає', () => {
    render(
      <SectionErrorBoundary label="Рахунок">
        <div>вміст секції</div>
      </SectionErrorBoundary>,
    );
    expect(screen.getByText('вміст секції')).toBeInTheDocument();
  });

  it('краш секції → показує банер з label, НЕ прокидає помилку далі', () => {
    render(
      <div>
        <span>сусідній контент</span>
        <SectionErrorBoundary label="Рахунок">
          <Boom />
        </SectionErrorBoundary>
      </div>,
    );
    // Банер із назвою секції показано; сусідній контент лишився (сторінка не впала).
    expect(screen.getByRole('alert')).toHaveTextContent('Рахунок');
    expect(screen.getByText('сусідній контент')).toBeInTheDocument();
    // MUTATION-VERIFY: без getDerivedStateFromError краш прокинувся б і завалив увесь render.
  });

  it('кастомний fallback має пріоритет над стандартним банером', () => {
    render(
      <SectionErrorBoundary fallback={<div>custom fallback</div>}>
        <Boom />
      </SectionErrorBoundary>,
    );
    expect(screen.getByText('custom fallback')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('«Спробувати ще раз» скидає стан (повторний рендер дітей)', () => {
    // Діти кидають лише на першому рендері — після reset показуються нормально.
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error('once');
      return <div>відновлено</div>;
    }
    render(
      <SectionErrorBoundary label="Рахунок">
        <Flaky />
      </SectionErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    shouldThrow = false;
    fireEvent.click(screen.getByText('Спробувати ще раз'));
    expect(screen.getByText('відновлено')).toBeInTheDocument();
  });
});
