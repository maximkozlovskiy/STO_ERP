import { render, screen } from '@testing-library/react';
import { Wrench } from 'lucide-react';
import { it, expect, describe } from 'vitest';
import { EmptyState } from '../empty-state';

describe('EmptyState', () => {
  it('рендерить дефолтний title коли title не передано', () => {
    render(<EmptyState />);
    expect(screen.getByText('Нічого не знайдено')).toBeInTheDocument();
  });

  it('рендерить кастомний title', () => {
    render(<EmptyState title="Немає нарядів" />);
    expect(screen.getByText('Немає нарядів')).toBeInTheDocument();
  });

  it('рендерить description коли передано', () => {
    render(
      <EmptyState title="Немає нарядів" description="Створіть перший наряд через кнопку вище" />,
    );
    expect(screen.getByText('Створіть перший наряд через кнопку вище')).toBeInTheDocument();
  });

  it('не рендерить description коли не передано', () => {
    const { container } = render(<EmptyState title="Заголовок" />);
    // Тільки один <p> для title — без додаткового для description
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs.length).toBe(1);
  });

  it('рендерить action ReactNode коли передано', () => {
    render(
      <EmptyState
        title="Порожньо"
        action={<button>Додати наряд</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Додати наряд' })).toBeInTheDocument();
  });

  it('не рендерить action коли не передано', () => {
    render(<EmptyState title="Порожньо" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('приймає кастомну іконку (LucideIcon)', () => {
    const { container } = render(<EmptyState icon={Wrench} title="Тест" />);
    // SVG лежить в обгортці з класом rounded-full
    const iconWrapper = container.querySelector('.rounded-full svg');
    expect(iconWrapper).toBeTruthy();
  });

  it('розмір sm застосовує менші класи', () => {
    const { container } = render(<EmptyState size="sm" title="Тест" />);
    // sm використовує py-8
    expect(container.firstChild).toHaveClass('py-8');
  });

  it('розмір md (default) застосовує py-14', () => {
    const { container } = render(<EmptyState title="Тест" />);
    expect(container.firstChild).toHaveClass('py-14');
  });

  it('розмір lg застосовує py-20', () => {
    const { container } = render(<EmptyState size="lg" title="Тест" />);
    expect(container.firstChild).toHaveClass('py-20');
  });

  it('передає className', () => {
    const { container } = render(
      <EmptyState title="Тест" className="custom-empty-state-class" />,
    );
    expect(container.firstChild).toHaveClass('custom-empty-state-class');
  });
});
