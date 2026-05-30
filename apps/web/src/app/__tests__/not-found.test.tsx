import { render, screen } from '@testing-library/react';
import { it, expect, describe } from 'vitest';
import NotFound from '../not-found';

describe('NotFound (app/not-found.tsx — Next.js App Router 404 boundary)', () => {
  it('рендерить код 404', () => {
    render(<NotFound />);
    expect(screen.getByText('404')).toBeInTheDocument();
  });

  it('рендерить кириличний заголовок', () => {
    render(<NotFound />);
    expect(screen.getByRole('heading', { name: 'Сторінку не знайдено' })).toBeInTheDocument();
  });

  it('містить link на /dashboard з кириличним текстом', () => {
    render(<NotFound />);
    const link = screen.getByRole('link', { name: 'На головну' });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/dashboard');
  });

  it('пояснення кириличне', () => {
    render(<NotFound />);
    expect(
      screen.getByText('Вказаної сторінки не існує або вона була переміщена.'),
    ).toBeInTheDocument();
  });
});
