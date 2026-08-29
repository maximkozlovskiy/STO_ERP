// Regression-guard для SupplierPaymentCreateModal — джерело коштів (каса/банк).
//
// Bug guarded (code-review 2026-08-20, family Bug #592):
//   Модалка ділить sessionStorage-ключі 'cache:bank-accounts' / 'cache:cash-registers'
//   з /ndi BankAccountsTab та CashRegistersTab, які зберігають форму { items: [...] }.
//   Раніше модалка читала/писала ГОЛИЙ масив → конфлікт форм: коли модалка читала
//   об'єкт { items } з таба (truthy) і клала його у setBanks → banks.map crash
//   (особливо коли offline apiFetch падав і .catch ковтав помилку — first-class
//   сценарій offline-first ERP).
//
// Fix: модалка читає { items } з Array.isArray guard і пише { items } (той самий
// контракт що таби + API-відповідь). Ці тести фіксують обидві сторони.

import { screen, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';

import { SupplierPaymentCreateModal } from '../SupplierPaymentCreateModal';
// Bug #593: модалка використовує React Query хуки → потрібен QueryClientProvider.
// Спільний helper (simplify/reuse) замість локальної копії.
import { renderWithQueryClient } from '../../../__tests__/query-utils';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false }),
}));

describe('SupplierPaymentCreateModal — cache-shape regression (family Bug #592)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('не крашиться коли cache має { items } форму (з таба) а apiFetch падає offline', async () => {
    // Таб записав канонічну форму { items }.
    window.sessionStorage.setItem(
      'cache:bank-accounts',
      JSON.stringify({ items: [{ id: 'ba1', name: 'Основний' }], total: 1 }),
    );
    window.sessionStorage.setItem(
      'cache:cash-registers',
      JSON.stringify({ items: [{ id: 'cr1', name: 'Каса №1' }], total: 1 }),
    );
    // Offline: усі reference-fetch падають (як у реальному offline-first сценарії).
    apiFetchMock.mockRejectedValue(new Error('offline'));

    expect(() =>
      renderWithQueryClient(
        <SupplierPaymentCreateModal open onClose={() => {}} onSaved={() => {}} />,
      ),
    ).not.toThrow();
    // Модалка відрендерилась, дефолтне джерело CASH_REGISTER → каса з кешу присутня.
    await waitFor(() => expect(screen.getByText('Каса №1')).toBeInTheDocument());
  });

  it('не крашиться коли cache — голий масив (стара форма модалки)', async () => {
    window.sessionStorage.setItem(
      'cache:cash-registers',
      JSON.stringify([{ id: 'cr1', name: 'Каса №1' }]),
    );
    apiFetchMock.mockRejectedValue(new Error('offline'));

    expect(() =>
      renderWithQueryClient(
        <SupplierPaymentCreateModal open onClose={() => {}} onSaved={() => {}} />,
      ),
    ).not.toThrow();
  });

  it('пише у cache канонічну { items } форму (не голий масив)', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/bank-accounts')
        return Promise.resolve({ items: [{ id: 'ba1', name: 'Основний' }], total: 1 });
      if (path === '/cash-registers')
        return Promise.resolve({ items: [{ id: 'cr1', name: 'Каса №1' }], total: 1 });
      if (path === '/payment-methods') return Promise.resolve([]);
      return Promise.resolve({ items: [], total: 0 });
    });

    renderWithQueryClient(
      <SupplierPaymentCreateModal open onClose={() => {}} onSaved={() => {}} />,
    );

    await waitFor(() => {
      const raw = window.sessionStorage.getItem('cache:bank-accounts');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw as string);
      // Канонічна форма — об'єкт з масивом items, НЕ голий масив.
      expect(Array.isArray(parsed)).toBe(false);
      expect(Array.isArray(parsed.items)).toBe(true);
    });
  });
});
