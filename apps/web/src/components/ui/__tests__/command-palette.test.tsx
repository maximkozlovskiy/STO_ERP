import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { CommandPalette } from '../command-palette';

// next/navigation is referenced via useRouter — mock it for jsdom tests.
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
}));

describe('CommandPalette', () => {
  beforeEach(() => {
    pushMock.mockClear();
  });

  it('не рендерить нічого якщо open=false', () => {
    render(<CommandPalette open={false} role="ADMIN" onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('рендерить діалог із combobox і listbox коли open=true', () => {
    render(<CommandPalette open role="ADMIN" onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Результати пошуку' })).toBeInTheDocument();
  });

  it('Bug #42: клік по backdrop викликає onClose', async () => {
    const onClose = vi.fn();
    const { container } = render(<CommandPalette open role="ADMIN" onClose={onClose} />);

    // Backdrop — div with aria-hidden=true containing bg-black/40
    const backdrop = container.querySelector('[aria-hidden="true"].bg-black\\/40');
    expect(backdrop).not.toBeNull();

    await userEvent.pointer({ keys: '[MouseLeft>]', target: backdrop as Element });

    expect(onClose).toHaveBeenCalled();
  });

  it('клік усередині панелі НЕ закриває палітру', async () => {
    const onClose = vi.fn();
    render(<CommandPalette open role="ADMIN" onClose={onClose} />);

    const input = screen.getByRole('combobox');
    await userEvent.click(input);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape закриває палітру', async () => {
    const onClose = vi.fn();
    render(<CommandPalette open role="ADMIN" onClose={onClose} />);

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  it('рендерить nav команди залежно від ролі (ADMIN бачить Налаштування)', () => {
    render(<CommandPalette open role="ADMIN" onClose={vi.fn()} />);
    expect(screen.getByRole('option', { name: /Налаштування/ })).toBeInTheDocument();
  });

  it('MECHANIC НЕ бачить /settings (role-filtered)', () => {
    render(<CommandPalette open role="MECHANIC" onClose={vi.fn()} />);
    expect(screen.queryByRole('option', { name: /Налаштування/ })).not.toBeInTheDocument();
    // але бачить публічні nav-команди
    expect(screen.getByRole('option', { name: /Наряди/ })).toBeInTheDocument();
  });

  it('пошук фільтрує команди по label і keywords', async () => {
    render(<CommandPalette open role="ADMIN" onClose={vi.fn()} />);
    const input = screen.getByRole('combobox');

    await userEvent.type(input, 'наряд');

    // Має знайти "Наряди" (label) і "Новий наряд" (label)
    expect(screen.getByRole('option', { name: /^Наряди/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Новий наряд/ })).toBeInTheDocument();
    // НЕ має знайти "Дашборд"
    expect(screen.queryByRole('option', { name: /Дашборд/ })).not.toBeInTheDocument();
  });

  it('Bug #45: активний option має aria-selected=true', async () => {
    render(<CommandPalette open role="ADMIN" onClose={vi.fn()} />);

    // Перший option активний за замовчуванням
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'false');

    // ArrowDown → активний другий
    await userEvent.keyboard('{ArrowDown}');
    const optionsAfter = screen.getAllByRole('option');
    expect(optionsAfter[0]).toHaveAttribute('aria-selected', 'false');
    expect(optionsAfter[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('Bug #45: input має aria-activedescendant що вказує на активний option', async () => {
    render(<CommandPalette open role="ADMIN" onClose={vi.fn()} />);

    const input = screen.getByRole('combobox');
    const activeId = input.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();

    const activeOption = document.getElementById(activeId!);
    expect(activeOption).toHaveAttribute('aria-selected', 'true');
  });

  it('Enter виконує активну команду', async () => {
    const onClose = vi.fn();
    render(<CommandPalette open role="ADMIN" onClose={onClose} />);

    // Перша команда — Дашборд → router.push('/dashboard')
    await userEvent.keyboard('{Enter}');

    expect(pushMock).toHaveBeenCalledWith('/dashboard');
    expect(onClose).toHaveBeenCalled();
  });

  it('показує "Нічого не знайдено" при порожньому фільтрі', async () => {
    render(<CommandPalette open role="ADMIN" onClose={vi.fn()} />);
    const input = screen.getByRole('combobox');

    await userEvent.type(input, 'хххх_неіснуюча_команда');

    expect(screen.getByText('Нічого не знайдено')).toBeInTheDocument();
  });

  it('ArrowDown зупиняється на останньому елементі', async () => {
    render(<CommandPalette open role="ADMIN" onClose={vi.fn()} />);

    // Завести запит що дасть рівно 1 результат
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'Дашборд');

    const optionsBefore = screen.getAllByRole('option');
    expect(optionsBefore).toHaveLength(1);

    // ArrowDown 5 раз — індекс має лишитися 0
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
  });
});
