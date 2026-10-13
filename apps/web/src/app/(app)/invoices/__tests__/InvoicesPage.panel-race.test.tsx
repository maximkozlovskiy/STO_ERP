// Bug #840: бокова панель рахунків після швидкого перемикання рядків показувала ПОПЕРЕДНІЙ рахунок.
//
// Панель рахунку відкриває клік по рядку: selectInvoice одразу показує рядок зі списку і паралельно
// довантажує рахунок (`GET /invoices/:id`). Відповідь писалась у стан без перевірки, чий це
// рахунок: вибрали A, одразу B, відповідь по A прийшла пізніше — і в панелі знову A (шапка,
// «Зведення», кнопки дій — усе чуже), хоча користувач клікнув B. Наживо 2026-10-13 із затримкою
// 2,5 с на запиті A.
//
// Mutation-verify (2026-10-13): повернути `setSelectedInv(detail)` без сторожа → падають обидва кейси.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/invoices',
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
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));

const INV_A = {
  id: 'inv-a',
  orgId: 'org-1',
  number: 'РАХ-0001',
  status: 'DRAFT',
  invoiceType: 'STANDARD',
  counterpartyId: 'cp-1',
  counterpartyName: 'Клієнт Перший',
  workOrderId: null,
  amount: 100,
  paidAmount: 0,
  dueDate: null,
  documentDate: '2026-10-13T00:00:00.000Z',
  notes: null,
  createdAt: '2026-10-13T08:00:00.000Z',
  updatedAt: '2026-10-13T08:00:00.000Z',
  deletedAt: null,
};
const INV_B = { ...INV_A, id: 'inv-b', number: 'РАХ-0002', counterpartyName: 'Клієнт Другий' };

vi.mock('@/hooks/api/useInvoices', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/useInvoices')>();
  return {
    ...actual,
    useInvoices: () => ({
      data: { items: [INV_A, INV_B], total: 2, page: 1, limit: 20 },
      isLoading: false,
      error: null,
    }),
  };
});
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));
vi.mock('@/components/ui/InvoiceCreateModal', () => ({ InvoiceCreateModal: () => null }));
vi.mock('@/components/ui/QrPaymentModal', () => ({ QrPaymentModal: () => null }));
vi.mock('@/components/ui/date-picker-input', () => ({ DatePickerInput: () => null }));

import InvoicesPage from '../page';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <InvoicesPage />
    </QueryClientProvider>,
  );
}

const row = (number: string) =>
  screen
    .getAllByText(number)
    .map(el => el.closest('tr'))
    .find(tr => tr !== null)!;
// Панель відкриває клік по рядку (стандарт списків 2026-10-13); олівець тепер відкриває картку.
const openPanel = (number: string) => fireEvent.click(row(number));
/** Заголовок відкритої панелі (номер рахунку в <h2>). */
const panelTitle = () => screen.queryByRole('heading', { level: 2 })?.textContent ?? '';

describe('Рахунки — бокова панель: пізня відповідь попереднього рахунку', () => {
  let resolveDetailA: (v: unknown) => void;

  beforeEach(() => {
    localStorage.clear();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/invoices/inv-a') {
        // Повільний запит: відповідь прийде лише коли тест її відпустить.
        return new Promise(resolve => {
          resolveDetailA = resolve;
        });
      }
      if (path === '/invoices/inv-b') return Promise.resolve({ ...INV_B, lines: [] });
      if (path.endsWith('/lines-summary')) return Promise.resolve({ tables: [], executors: [] });
      if (path.endsWith('/linked-documents')) return Promise.resolve({});
      if (path === '/invoices/linked-counts') return Promise.resolve({});
      return Promise.resolve({});
    });
  });

  it('вибрали A, потім B; відповідь по A прийшла пізніше → панель лишається на B', async () => {
    renderPage();
    await screen.findByText('РАХ-0001');

    openPanel('РАХ-0001');
    await waitFor(() => expect(panelTitle()).toBe('РАХ-0001'));
    openPanel('РАХ-0002');
    await waitFor(() => expect(panelTitle()).toBe('РАХ-0002'));

    resolveDetailA({ ...INV_A, lines: [] });
    // Даємо пізній відповіді дійти до стану.
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/invoices/inv-b'));
    await new Promise(r => setTimeout(r, 30));

    expect(panelTitle()).toBe('РАХ-0002');
    expect(row('РАХ-0002')).toHaveClass('bg-primary/5');
    expect(row('РАХ-0001')).not.toHaveClass('bg-primary/5');
  });

  it('закрили панель, доки вантажився рахунок → пізня відповідь її не відкриває', async () => {
    renderPage();
    await screen.findByText('РАХ-0001');

    openPanel('РАХ-0001');
    await waitFor(() => expect(panelTitle()).toBe('РАХ-0001'));
    fireEvent.click(screen.getByTitle('Закрити'));
    await waitFor(() => expect(screen.queryByTestId('lines-summary')).not.toBeInTheDocument());

    resolveDetailA({ ...INV_A, lines: [] });
    await new Promise(r => setTimeout(r, 30));

    expect(screen.queryByTestId('lines-summary')).not.toBeInTheDocument();
    expect(row('РАХ-0001')).not.toHaveClass('bg-primary/5');
  });
});
