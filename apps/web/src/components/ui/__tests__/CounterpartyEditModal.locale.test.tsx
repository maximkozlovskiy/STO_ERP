import { render, screen, fireEvent, within } from '@testing-library/react';
import { it, expect, describe, afterEach, beforeEach, vi } from 'vitest';
import i18n from '@/i18n/config';
import { CounterpartyEditModal, type CounterpartyForModal } from '../CounterpartyEditModal';
import { createQueryWrapper } from '@/__tests__/query-utils';

/**
 * Картку контрагента відкривають із карток документів (замовлення постачальнику, товар) — її
 * вкладки й вбудовані форми (CounterpartyForm, VehicleForm) лишались українськими в en (батч C
 * i18n). uk-тексти — ті самі, що до перекладу: на них тримаються інші тести й E2E.
 */

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false, unsavedGuardEnabled: false }),
}));
vi.mock('@/hooks/useDirtyForm', () => ({
  useDirtyForm: () => ({
    isDirty: false,
    markDirty: vi.fn(),
    resetDirty: vi.fn(),
    confirmClose: () => Promise.resolve(true),
    dialogProps: { open: false },
  }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role: 'OWNER' } }),
}));
vi.mock('@/components/ui/CounterpartyStatusManager', () => ({
  StatusManager: () => null,
}));

const CYRILLIC = /[А-Яа-яІіЇїЄєҐґ]/;

// Дані користувача — латиницею, щоб перевірка «жодної кирилиці» стосувалась лише інтерфейсу.
const counterparty: CounterpartyForModal = {
  id: 'cp-1',
  type: 'SUPPLIER',
  firstName: null,
  lastName: null,
  companyName: 'Test LLC',
  vatPayer: false,
};

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string) => {
    if (/\/garages$/.test(path)) return Promise.resolve([{ id: 'g-1' }]);
    if (path.startsWith('/vehicles?')) {
      return Promise.resolve([
        { id: 'v-1', make: 'BMW', model: 'X5', year: 2015, licensePlate: 'AA1234BB' },
      ]);
    }
    if (/\/contracts/.test(path)) {
      return Promise.resolve([
        {
          id: 'c-1',
          number: 'D-001',
          contractType: 'PURCHASE',
          startDate: '2026-01-15T00:00:00.000Z',
          endDate: null,
          isPrimary: true,
          creditLimit: null,
          currencyCode: 'UAH',
          paymentDeferDays: null,
        },
      ]);
    }
    if (path.startsWith('/work-orders')) {
      return Promise.resolve({
        items: [
          {
            id: 'wo-1',
            number: 'WO-1',
            status: 'DRAFT',
            totalAmount: 100,
            createdAt: '2026-01-15T00:00:00.000Z',
            vehicleSummary: 'BMW X5',
          },
        ],
      });
    }
    if (path === '/settings/organisation') return Promise.resolve({ currency: 'UAH' });
    if (path === '/currencies') {
      return Promise.resolve({ items: [{ code: 'UAH', name: 'Hryvnia' }], total: 1 });
    }
    // Довідник марок (форма авто, BR-VEH-008) — латиницею, як і решта даних користувача.
    if (path === '/vehicle-makes') {
      return Promise.resolve({
        items: [{ id: 'mk-1', name: 'BMW', vehicleCount: 1, modelCount: 0, deletedAt: null }],
        total: 1,
      });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});

afterEach(async () => {
  await i18n.changeLanguage('uk');
});

const renderModal = (cp: CounterpartyForModal | null) =>
  render(<CounterpartyEditModal open counterparty={cp} onClose={() => {}} onSaved={() => {}} />, {
    wrapper: createQueryWrapper(),
  });

async function openTab(name: RegExp, marker: string) {
  fireEvent.click(screen.getByRole('button', { name }));
  await screen.findByRole('button', { name: marker });
}

describe('CounterpartyEditModal — тексти за мовою інтерфейсу', () => {
  it('uk — вкладки, форма, авто, договори й історія без змін', async () => {
    renderModal(counterparty);
    expect(screen.getByRole('dialog', { name: 'Редагування контрагента' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Назва компанії/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Юридичні реквізити' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Оновити' })).toBeInTheDocument();

    await openTab(/^Авто/, 'Додати авто');
    expect(screen.getByText('1 авто')).toBeInTheDocument();
    expect(screen.getByText('Марка / Модель')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Додати авто' }));
    expect(screen.getByRole('group', { name: /^Марка/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Держномер')).toBeInTheDocument();

    await openTab(/^Договори/, 'Додати договір');
    expect(screen.getByText('1 договор')).toBeInTheDocument();
    expect(screen.getByText('Головний')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Історія/ }));
    expect(await screen.findByText('Сума')).toBeInTheDocument();
  });

  it('uk — новий контрагент: заголовок і «Зберегти»', () => {
    renderModal(null);
    expect(screen.getByRole('dialog', { name: 'Новий контрагент' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Зберегти' })).toBeInTheDocument();
  });

  it('en — англійські тексти на кожній вкладці, жодного українського', async () => {
    await i18n.changeLanguage('en');
    renderModal(counterparty);
    const dialog = screen.getByRole('dialog', { name: 'Edit counterparty' });
    expect(screen.getByLabelText(/^Company name/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Legal details' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bank details' })).toBeInTheDocument();
    expect(
      within(dialog).getByRole('option', { name: 'Individual', hidden: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(CYRILLIC);

    await openTab(/^Vehicles/, 'Add vehicle');
    expect(screen.getByText('Vehicles: 1')).toBeInTheDocument();
    expect(screen.getByText('Make / Model')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add vehicle' }));
    expect(screen.getByRole('group', { name: /^Make/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Make' })).toHaveAttribute(
      'placeholder',
      'Search make…',
    );
    expect(screen.getByLabelText('Plate number')).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(CYRILLIC);

    await openTab(/^Contracts/, 'Add contract');
    expect(screen.getByText('Contracts: 1')).toBeInTheDocument();
    expect(screen.getByText('Primary')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add contract' }));
    expect(screen.getByText('Contract type')).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(CYRILLIC);

    fireEvent.click(screen.getByRole('button', { name: /^History/ }));
    expect(await screen.findByText('Amount')).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(CYRILLIC);
  });

  it('en — новий контрагент: заголовок і «Save»', async () => {
    await i18n.changeLanguage('en');
    renderModal(null);
    const dialog = screen.getByRole('dialog', { name: 'New counterparty' });
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(CYRILLIC);
  });
});
