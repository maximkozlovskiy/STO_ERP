// Кеш постачальників вкладки «Товари» (`cache:suppliers`, sessionStorage) — лише поля вибору.
// `GET /counterparties` звужується за роллю (BR-CP-014: комірник — без телефону, e-mail і
// балансу), а кеш вкладки виходом не очищується: рядки власника з телефоном прочитав би комірник,
// що увійшов у тій самій вкладці.

import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/catalog',
}));
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
  useAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
}));
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiBlobFetch: vi.fn(),
}));
const cache = vi.hoisted(() => ({ setCache: vi.fn() }));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: cache.setCache }));
vi.mock('@/components/ui/xlsx-import-button', () => ({ XlsxImportButton: () => null }));
vi.mock('@/components/ui/GoodEditModal', () => ({ GoodEditModal: () => null }));

import GoodsTab from '../GoodsTab';

const OWNER_ROW = {
  id: 's-1',
  type: 'SUPPLIER',
  firstName: null,
  lastName: null,
  companyName: 'ТОВ Запчастини',
  phone: '+380671112233',
  email: 'sup@sto.local',
  balance: -1500,
  notes: 'нотатка',
};

describe('GoodsTab — кеш постачальників (BR-CP-014)', () => {
  // guards: BR-CP-014
  it('у cache:suppliers — лише id і назва, без телефону, e-mail і балансу', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/counterparties')) return Promise.resolve({ items: [OWNER_ROW] });
      if (url.startsWith('/units') || url.startsWith('/good-categories'))
        return Promise.resolve([]);
      return Promise.resolve({ items: [], total: 0 });
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <GoodsTab />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(cache.setCache).toHaveBeenCalledWith('cache:suppliers', expect.anything()),
    );
    const [, rows] = cache.setCache.mock.calls.find(c => c[0] === 'cache:suppliers')!;
    expect(rows).toEqual([
      { id: 's-1', firstName: null, lastName: null, companyName: 'ТОВ Запчастини' },
    ]);
  });
});
