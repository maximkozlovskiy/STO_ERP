// Regression-guard для BankAccountsTab — вкладка «Банк. рахунки» на /bank-statements?tab=accounts
// (перенесено з /ndi у ході UI-реорганізації навколо банківських рахунків).
//
// Bug guarded:
//   #592 (HIGH) — Runtime TypeError "Cannot read properties of undefined (reading 'map')".
//     getCached('cache:bank-accounts') / getCached('cache:currencies') повертає
//     розпарсений JSON БЕЗ валідації форми. Якщо у sessionStorage лежить запис
//     зі старою/зіпсованою формою (наприклад { items: undefined } від попереднього
//     білду, або голий масив), то setBankAccounts(cached.items) писало undefined
//     у state → bankAccounts.map(...) крашив весь компонент.
//     Fix: guard `Array.isArray(cached.items)` перед setX.
//
// Також: auto-pull бейдж (Частина C) — рахунок з autoPullEnabled показує «Авто-pull: <provider>»
// без відкриття форми.

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
      if (path === '/bank-statement-providers') return Promise.resolve([]);
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

describe('BankAccountsTab — auto-pull бейдж (Частина C)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    window.sessionStorage.clear();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/bank-accounts')
        return Promise.resolve({
          items: [
            {
              id: 'ba1',
              name: 'Основний',
              ibanUA: 'UA213223130000026007233566001',
              currencyId: 'c1',
              currencyCode: 'UAH',
              autoPullEnabled: true,
              provider: 'privat24',
            },
            {
              id: 'ba2',
              name: 'Резервний',
              ibanUA: 'UA999999999999999999999999999',
              currencyId: 'c1',
              currencyCode: 'UAH',
              autoPullEnabled: false,
              provider: null,
            },
          ],
          total: 2,
        });
      if (path === '/currencies') return Promise.resolve({ items: [], total: 0 });
      if (path === '/branches') return Promise.resolve({ items: [], total: 0 });
      if (path === '/bank-statement-providers')
        return Promise.resolve([
          { code: 'privat24', name: 'Приват24' },
          { code: 'monobank', name: 'monobank' },
        ]);
      return Promise.resolve({ items: [], total: 0 });
    });
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('рахунок з autoPullEnabled → бейдж «Авто-pull: Приват24»', async () => {
    render(<BankAccountsTab />);
    // Провайдер-мапа приходить асинхронно → людська назва замість коду.
    await waitFor(() => expect(screen.getByText(/Авто-pull: Приват24/)).toBeInTheDocument());
  });

  it('рахунок без autoPullEnabled → без бейджа', async () => {
    render(<BankAccountsTab />);
    await screen.findByText('Резервний');
    // Лише один auto-pull бейдж (у першого рахунку), не у резервного.
    expect(screen.queryAllByText(/Авто-pull:/)).toHaveLength(1);
  });
});
