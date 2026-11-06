// Масове видалення контрагентів: відмова сервера показується ПРИЧИНОЮ, а не лише лічильником.
// Без причини «Видалено 1 з 2. 1 не вдалось» не каже, що робити далі — для BR-CP-019 (увімкнене
// підключення до API постачальника) треба вимкнути підключення, для інших відмов — закрити
// наряди чи обнулити борг.
//
// Mutation-verify: повернути `t('toast.deletedPartial', …)` без `withReasons` → кейс падає.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { urlStore } from '@/__tests__/url-store';
import { tableRow } from '../../../../__tests__/row-click-standard';

vi.mock('next/navigation', async () =>
  (await import('@/__tests__/url-store')).navigationMock('/counterparties'),
);
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
  useAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
}));
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiBlobFetch: vi.fn(),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock('@/lib/toast', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/toast')>()),
  toast: toastMock,
}));

const CP_A = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  orgId: 'org-1',
  type: 'SUPPLIER',
  companyName: 'ТОВ Перший',
  firstName: null,
  lastName: null,
  phone: null,
  email: null,
  vatPayer: false,
  balance: 0,
  createdAt: '2026-11-06T08:00:00.000Z',
  updatedAt: '2026-11-06T08:00:00.000Z',
  deletedAt: null as string | null,
};
const CP_B = { ...CP_A, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', companyName: 'ТОВ Другий' };
const REASON =
  'Неможливо видалити: у контрагента є увімкнені підключення до API постачальника (AVD Trade) — спершу вимкніть їх у «Налаштування → Постачальники API»';

import CounterpartiesPage from '../page';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CounterpartiesPage />
    </QueryClientProvider>,
  );
}

/** Текст, яким сторінка повідомила про результат: toast або рядок помилки на сторінці. */
const reported = () =>
  [...toastMock.warning.mock.calls, ...toastMock.error.mock.calls, ...toastMock.success.mock.calls]
    .map(c => String(c[0]))
    .join('\n') + (document.body.textContent ?? '');

describe('Контрагенти — масове видалення', () => {
  beforeEach(() => {
    urlStore.reset();
    localStorage.clear();
    Object.values(toastMock).forEach(m => m.mockReset());
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') {
        return path.endsWith(CP_A.id)
          ? Promise.reject(new Error(REASON))
          : Promise.resolve(undefined);
      }
      if (path.startsWith('/counterparties?')) {
        return Promise.resolve({ items: [CP_A, CP_B], total: 2, page: 1, limit: 20 });
      }
      if (path.includes('/vehicles')) return Promise.resolve([]);
      return Promise.resolve({});
    });
  });

  // guards: BR-CP-019
  it('частина не видалилась → повідомлення містить причину сервера, а не лише лічильник', async () => {
    renderPage();
    await screen.findByText('ТОВ Перший');
    fireEvent.click(within(tableRow('ТОВ Перший')).getByRole('checkbox'));
    fireEvent.click(within(tableRow('ТОВ Другий')).getByRole('checkbox'));
    fireEvent.click(await screen.findByRole('button', { name: 'Видалити вибраних' }));

    await waitFor(() => expect(reported()).toMatch(/Видалено 1 з 2/));
    expect(reported()).toContain('спершу вимкніть їх');
  });
});
