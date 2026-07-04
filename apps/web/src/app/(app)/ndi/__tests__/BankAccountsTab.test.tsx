// Regression-guard для BankAccountsTab — вкладка "Банківські рахунки" у /ndi.
//
// Bug guarded:
//   #592 (HIGH) — Runtime TypeError "Cannot read properties of undefined (reading 'map')".
//     getCached('cache:bank-accounts') / getCached('cache:currencies') повертає
//     розпарсений JSON БЕЗ валідації форми. Якщо у sessionStorage лежить запис
//     зі старою/зіпсованою формою (наприклад { items: undefined } від попереднього
//     білду, або голий масив), то setBankAccounts(cached.items) писало undefined
//     у state → bankAccounts.map(...) крашив весь NdiPageClient.
//     Fix: guard `Array.isArray(cached.items)` перед setX.

import { render, screen, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';

import BankAccountsTab from '../BankAccountsTab';

// ─── Module mocks ────────────────────────────────────────────────────────────

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false }),
}));

vi.mock('@/hooks/useConfirm', () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true), dialogProps: {} }),
}));

// ref-cache читає sessionStorage напряму — керуємо через jsdom sessionStorage.

describe('BankAccountsTab — malformed cache regression (Bug #592)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    window.sessionStorage.clear();
    // API повертає валідну форму — щоб перевірити саме cache-path, не fetch.
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/bank-accounts') return Promise.resolve({ items: [], total: 0 });
      if (path === '/currencies') return Promise.resolve({ items: [], total: 0 });
      if (path === '/branches') return Promise.resolve({ items: [], total: 0 });
      return Promise.resolve({ items: [], total: 0 });
    });
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('не крашиться коли cache:bank-accounts має items=undefined', async () => {
    // Зіпсований кеш — форма без масиву items (leftover зі старого білду).
    window.sessionStorage.setItem('cache:bank-accounts', JSON.stringify({ total: 0 }));

    expect(() => render(<BankAccountsTab />)).not.toThrow();
    // Після resolve fetch — рендериться empty state, не crash.
    await waitFor(() => expect(screen.getByText('Рахунки не додано')).toBeInTheDocument());
  });

  it('не крашиться коли cache:currencies має items=undefined', async () => {
    window.sessionStorage.setItem('cache:currencies', JSON.stringify({ total: 0 }));

    expect(() => render(<BankAccountsTab />)).not.toThrow();
    await waitFor(() => expect(screen.getByText('Рахунки не додано')).toBeInTheDocument());
  });

  it('не крашиться коли cache:bank-accounts — голий масив (стара форма)', async () => {
    // Стара форма: setCache зберігав голий масив замість { items }.
    window.sessionStorage.setItem('cache:bank-accounts', JSON.stringify([{ id: 'x' }]));

    expect(() => render(<BankAccountsTab />)).not.toThrow();
    await waitFor(() => expect(screen.getByText('Рахунки не додано')).toBeInTheDocument());
  });

  it('використовує валідний кеш якщо форма правильна', async () => {
    window.sessionStorage.setItem(
      'cache:bank-accounts',
      JSON.stringify({
        items: [{ id: 'ba1', name: 'Основний', ibanUA: 'UA123', currencyId: 'c1' }],
        total: 1,
      }),
    );

    render(<BankAccountsTab />);
    // Кешований рядок видно синхронно (до resolve fetch).
    expect(screen.getByText('Основний')).toBeInTheDocument();
  });
});
