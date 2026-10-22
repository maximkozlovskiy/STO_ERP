import { render, screen } from '@testing-library/react';
import { it, expect, describe, afterEach, vi } from 'vitest';
import i18n from '@/i18n/config';
import { InvoiceConflictDialog } from '../work-order/InvoiceConflictDialog';

/**
 * Діалог «рахунок уже існує» вбудований у картку наряду: картку переклали (батч B), а дитина
 * лишалась українською в en (review d63c80d7). uk-тексти — ті самі, що до перекладу.
 */
describe('InvoiceConflictDialog — тексти за мовою інтерфейсу', () => {
  afterEach(async () => {
    await i18n.changeLanguage('uk');
  });

  const props = {
    open: true,
    loading: false,
    onClose: vi.fn(),
    onRefresh: vi.fn(),
    onOpenExisting: vi.fn(),
  };

  it('uk — заголовок, пояснення і три дії без змін', () => {
    render(<InvoiceConflictDialog {...props} />);
    expect(screen.getByRole('dialog', { name: 'Рахунок вже існує' })).toBeInTheDocument();
    expect(
      screen.getByText('Для цього наряду вже є активний рахунок. Що зробити?'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Оновити (перезаписати рядки)' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Відкрити існуючий' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeInTheDocument();
  });

  it('en — англійські тексти, жодного українського', async () => {
    await i18n.changeLanguage('en');
    render(<InvoiceConflictDialog {...props} />);
    expect(screen.getByRole('dialog', { name: 'Invoice already exists' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh (overwrite lines)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open existing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('dialog').textContent).not.toMatch(/[А-Яа-яІіЇїЄєҐґ]/);
  });
});
