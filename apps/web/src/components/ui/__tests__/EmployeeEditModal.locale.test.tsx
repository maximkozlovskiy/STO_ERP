import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';
import i18n from '@/i18n/config';

import { EmployeeEditModal, type EmployeeForModal } from '../EmployeeEditModal';

/**
 * Картка співробітника переведена на t() (батч D i18n-техборгу). uk — ті самі тексти, що до
 * перекладу (на них спираються E2E), en — без жодного українського рядка, включно з вбудованим
 * CheckboxList («Немає записів») і вкладками призначень.
 */

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: vi.fn(),
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
  }),
}));

const EMPLOYEE: EmployeeForModal = {
  id: 'e1',
  firstName: 'John',
  lastName: 'Smith',
  role: 'MECHANIC',
  phone: null,
  email: null,
  status: 'ACTIVE',
  rateScheme: { type: 'percent_normo', params: { percent: 40 } },
  zoneIds: [],
  liftIds: [],
  workCategoryIds: [],
  branchIds: [],
  allBranches: false,
};

const CYRILLIC = /[А-Яа-яІіЇїЄєҐґ]/;

describe('EmployeeEditModal — тексти за мовою інтерфейсу', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) =>
      Promise.resolve(path === '/branches' ? [{ id: 'b1', name: 'Main', address: 'Kyiv' }] : []),
    );
  });

  afterEach(async () => {
    await i18n.changeLanguage('uk');
  });

  it('uk — нова картка: заголовок, поля, схеми нарахування, доступ — без змін', () => {
    render(<EmployeeEditModal open employee={null} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Новий співробітник' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Іван')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Коваль')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '% від норма-год' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Ставка × нормо-год' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Ставка + бонус' })).toBeInTheDocument();
    expect(screen.getByText('Надати доступ до системи')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Зберегти' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeInTheDocument();
  });

  it('uk — картка наявного: вкладки призначень і порожній список «Немає записів»', async () => {
    render(<EmployeeEditModal open employee={EMPLOYEE} onClose={() => {}} onSaved={() => {}} />);
    expect(await screen.findByRole('button', { name: /Філії/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Зони та підйомники/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Категорії робіт/ })).toBeInTheDocument();
    expect(screen.getAllByText('Немає записів')).toHaveLength(2);
  });

  it('en — нова картка з відкритим доступом: жодного українського тексту', async () => {
    await i18n.changeLanguage('en');
    render(<EmployeeEditModal open employee={null} onClose={() => {}} onSaved={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'New employee' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Grant system access' }));
    expect(screen.getByLabelText(/Login email/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '% of standard hours' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(CYRILLIC);
  });

  it('en — картка наявного: вкладки й вбудований CheckboxList англійською', async () => {
    await i18n.changeLanguage('en');
    render(<EmployeeEditModal open employee={EMPLOYEE} onClose={() => {}} onSaved={() => {}} />);
    expect(await screen.findByRole('button', { name: /Branches/ })).toBeInTheDocument();
    expect(screen.getAllByText('No records')).toHaveLength(2);
    await waitFor(() => expect(screen.getByRole('dialog').textContent).not.toMatch(CYRILLIC));
  });
});
