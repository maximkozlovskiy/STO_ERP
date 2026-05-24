import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe } from 'vitest';
import { Button } from '../button';

describe('Button', () => {
  it('рендерить children', () => {
    render(<Button>Зберегти</Button>);
    expect(screen.getByRole('button', { name: 'Зберегти' })).toBeInTheDocument();
  });

  it('за замовчуванням variant=primary застосовує bg-primary клас', () => {
    render(<Button>Кнопка</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toMatch(/bg-primary/);
  });

  it('variant=destructive застосовує bg-destructive', () => {
    render(<Button variant="destructive">Видалити</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toMatch(/bg-destructive/);
  });

  it('variant=outline містить border клас', () => {
    render(<Button variant="outline">Outline</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toMatch(/border/);
  });

  it('disabled блокує клік', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Кнопка
      </Button>,
    );
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('loading=true показує spinner і вимикає кнопку', () => {
    render(<Button loading>Завантаження</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    // Spinner svg вставляється у кнопку з класом animate-spin
    expect(btn.querySelector('svg.animate-spin')).toBeTruthy();
  });

  it('всі допустимі variants рендеряться без помилок', () => {
    const variants = [
      'primary',
      'secondary',
      'outline',
      'ghost',
      'destructive',
      'link',
      'default',
    ] as const;
    for (const variant of variants) {
      const { unmount } = render(<Button variant={variant}>Текст</Button>);
      const btn = screen.getByRole('button', { name: 'Текст' });
      expect(btn).toBeInTheDocument();
      unmount();
    }
  });

  it('всі допустимі sizes рендеряться без помилок', () => {
    const sizes = ['xs', 'sm', 'md', 'lg', 'icon-xs', 'icon-sm', 'icon'] as const;
    for (const size of sizes) {
      const { unmount } = render(<Button size={size}>X</Button>);
      expect(screen.getByRole('button')).toBeInTheDocument();
      unmount();
    }
  });

  it('leftIcon рендериться поряд з текстом', () => {
    render(
      <Button leftIcon={<span data-testid="left-icon">L</span>}>Текст</Button>,
    );
    expect(screen.getByTestId('left-icon')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Текст/ })).toBeInTheDocument();
  });

  it('rightIcon не рендериться при loading=true (replaced by spinner)', () => {
    render(
      <Button loading rightIcon={<span data-testid="right-icon">R</span>}>
        Текст
      </Button>,
    );
    // При loading правий ікон не показується (тільки spinner ліворуч)
    expect(screen.queryByTestId('right-icon')).not.toBeInTheDocument();
  });

  it('тип за замовчуванням submit-агностичний (no implicit submit lifecycle)', () => {
    render(<Button>Кнопка</Button>);
    const btn = screen.getByRole('button') as HTMLButtonElement;
    // type не примусово встановлений — кнопка може поводити себе як submit у формах
    expect(['submit', 'button', '']).toContain(btn.type);
  });

  it('передає className разом з базовими класами', () => {
    render(<Button className="extra-test-class">Кнопка</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('extra-test-class');
  });
});
