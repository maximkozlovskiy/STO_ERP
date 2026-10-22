import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { it, expect, describe, afterEach, beforeEach, vi } from 'vitest';
import i18n from '@/i18n/config';
import { GoodEditModal, type GoodForModal } from '../GoodEditModal';

/**
 * Картка товару вкладена в картки документів (замовлення постачальнику, наряд): документи
 * переклали (батч C), тож картка товару та її вкладки штрихкодів / одиниць не мають лишатись
 * українськими в en. uk-тексти — ті самі, що до перекладу (E2E і unit шукають за текстом).
 */

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false, unsavedGuardEnabled: false }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role: 'OWNER' } }),
}));

const CYRILLIC = /[А-Яа-яІіЇїЄєҐґ]/;

const baseProps = {
  open: true,
  onClose: vi.fn(),
  onSaved: vi.fn(),
  brands: [],
  units: [],
  goodCatTree: [],
};

const good: GoodForModal = {
  id: 'g1',
  internalCode: 'G-0001',
  sku: 'OIL-1',
  name: 'Oil',
  unit: 'pcs',
  unitId: null,
  purchasePrice: 1,
  salePrice: 2,
  category: null,
  barcode: null,
  brandId: null,
  notes: null,
};

describe('GoodEditModal — тексти за мовою інтерфейсу', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/barcodes') || path.endsWith('/uoms')) return Promise.resolve([]);
      if (path === '/goods/g1') return Promise.resolve({ statuses: [] });
      return Promise.resolve({ items: [], total: 0 });
    });
  });

  afterEach(async () => {
    await i18n.changeLanguage('uk');
  });

  it('uk — нова картка: заголовок, поля, типи й кнопка без змін', () => {
    render(<GoodEditModal {...baseProps} good={null} />);
    expect(screen.getByRole('dialog', { name: 'Новий товар / запчастина' })).toBeInTheDocument();
    expect(screen.getByText('присвоюється автоматично')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Масло моторне 5W-40')).toBeInTheDocument();
    expect(screen.getByText('Основний постачальник')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Витратний матеріал' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Зберегти та продовжити' })).toBeInTheDocument();
  });

  it('en — нова картка без жодного українського тексту', async () => {
    await i18n.changeLanguage('en');
    render(<GoodEditModal {...baseProps} good={null} />);
    const dialog = screen.getByRole('dialog', { name: 'New good / spare part' });
    expect(screen.getByText('assigned automatically')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Consumable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and continue' })).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(CYRILLIC);
    // placeholder-и не потрапляють у textContent — перевіряємо окремо
    for (const el of dialog.querySelectorAll('[placeholder]')) {
      expect(el.getAttribute('placeholder')).not.toMatch(CYRILLIC);
    }
  });

  it('uk — редагування: вкладки штрихкодів і одиниць виміру без змін', async () => {
    render(<GoodEditModal {...baseProps} good={good} />);
    expect(screen.getByRole('dialog', { name: 'Редагування товару' })).toBeInTheDocument();
    expect(await screen.findByText('Штрихкодів немає')).toBeInTheDocument();
    expect(screen.getByText('0 штрихкодів')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Одиниці виміру/ }));
    expect(await screen.findByText('Додаткових одиниць не додано')).toBeInTheDocument();
    expect(screen.getByText('0 одиниці')).toBeInTheDocument();
  });

  it('en — редагування: вкладки англійською, жодного українського', async () => {
    await i18n.changeLanguage('en');
    render(<GoodEditModal {...baseProps} good={good} />);
    const dialog = screen.getByRole('dialog', { name: 'Edit good' });
    expect(await screen.findByText('No barcodes')).toBeInTheDocument();
    expect(screen.getByText('Barcodes: 0')).toBeInTheDocument();
    await waitFor(() => expect(dialog.textContent).not.toMatch(CYRILLIC));
    fireEvent.click(screen.getByRole('button', { name: /^Units of measure/ }));
    expect(await screen.findByText('No additional units added')).toBeInTheDocument();
    expect(screen.getByText('Units: 0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('How many base units are in one of this unit')).toBeInTheDocument();
    await waitFor(() => expect(dialog.textContent).not.toMatch(CYRILLIC));
  });
});
