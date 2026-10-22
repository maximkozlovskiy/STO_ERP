// Вкладка «Товари» не тягне перелік постачальників (TECH-DEBT §15.7, 2026-10-22). Раніше вона
// просила перших 200 (`/counterparties?types=SUPPLIER,BOTH&limit=200`) і клала їх у кеш
// `cache:suppliers` для картки товару, а картка шукає постачальника на сервері й перелік не читала:
// зайвий запит, обрізаний на 200, і кеш, який мусив звужуватись за роллю (BR-CP-014: рядки
// власника з телефоном прочитав би комірник, що увійшов у тій самій вкладці).

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

describe('GoodsTab — без переліку постачальників (BR-CP-014)', () => {
  // guards: BR-CP-014
  it('немає запиту /counterparties і кешу cache:suppliers', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/units') || url.startsWith('/good-categories'))
        return Promise.resolve([]);
      return Promise.resolve({ items: [], total: 0 });
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <GoodsTab />
      </QueryClientProvider>,
    );
    // Довідники вкладки завантажились — запит постачальників уже був би серед них.
    await waitFor(() =>
      expect(cache.setCache).toHaveBeenCalledWith('cache:good-categories', expect.anything()),
    );
    expect(apiFetchMock.mock.calls.map(c => String(c[0]))).not.toContainEqual(
      expect.stringMatching(/^\/counterparties/),
    );
    expect(cache.setCache.mock.calls.map(c => c[0])).not.toContain('cache:suppliers');
  });
});
