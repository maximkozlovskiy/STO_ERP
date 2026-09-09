'use client';

import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Назва секції для повідомлення (напр. «Оплати», «Медіа наряду»). */
  label?: string;
  /** Кастомний fallback замість стандартного банера. */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * E3 — per-section error boundary. Ізолює крах ОДНІЄЇ секції (money-панель, медіа наряду) від
 * усієї сторінки: замість білого екрана / Next error-overlay показує локальний банер, решта
 * сторінки лишається робочою. Class-component — бо error boundaries у React лише класові
 * (componentDidCatch/getDerivedStateFromError). Корневий app/error.tsx лишається як остання лінія.
 */
export class SectionErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    // Логуємо у консоль (Sentry не wired). Не кидаємо далі — секція ізольована.
    // eslint-disable-next-line no-console
    console.error(`[SectionErrorBoundary${this.props.label ? ` ${this.props.label}` : ''}]`, error);
  }

  private reset = () => this.setState({ hasError: false });

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return (
      <div
        role="alert"
        className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-3 flex items-center justify-between gap-3"
      >
        <span>
          {this.props.label
            ? `Не вдалося відобразити розділ «${this.props.label}».`
            : 'Не вдалося відобразити цей розділ.'}{' '}
          Решта сторінки працює.
        </span>
        <button
          onClick={this.reset}
          className="shrink-0 rounded px-2 py-1 text-[12px] font-medium border border-destructive-border hover:bg-destructive/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
        >
          Спробувати ще раз
        </button>
      </div>
    );
  }
}
