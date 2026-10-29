// BR-INV-023 у боковій панелі списку рахунків (рішення власника 2026-10-29 — як у картці): чернетку
// без рядків не виставити, тож «Надіслати» неактивна з підказкою; кількість рядків — зі зведення,
// яке панель уже читає. До відповіді зведення кнопка не блокується.
//
// Mutation-verify (2026-10-29): `disabled={false}` → падає «без рядків»; блок без перевірки
// кількості рядків → падає «з рядком».

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { urlStore } from '@/__tests__/url-store';
import { tableRow, panelShows } from '../../../../__tests__/row-click-standard';

// Картка — в адресі (`?open=<id>`): адреса мусить реагувати на push / replace / back.
vi.mock('next/navigation', async () =>
  (await import('@/__tests__/url-store')).navigationMock('/invoices'),
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

const INV_A = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
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
  deletedAt: null as string | null,
};
const INV_B = {
  ...INV_A,
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  number: 'РАХ-0002',
  counterpartyName: 'Клієнт Другий',
};
let listItems = [INV_A, INV_B];

vi.mock('@/hooks/api/useInvoices', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/useInvoices')>();
  return {
    ...actual,
    useInvoices: () => ({
      data: { items: listItems, total: listItems.length, page: 1, limit: 20 },
      isLoading: false,
      error: null,
    }),
  };
});
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
  useRetryCashFiscal: () => ({ mutateAsync: async () => ({}) }),
  // Каси для вікна «Оплатити» (BR-PAY-019); у цих тестах вікно не відкривається.
  useCashRegisters: () => ({ data: [] }),
}));
// Картка рахунку — маркер із id документа, з яким її відкрили.
vi.mock('@/components/ui/InvoiceCreateModal', () => ({
  InvoiceCreateModal: (p: { open: boolean; invoiceId?: string }) =>
    p.open && p.invoiceId ? <div data-testid="edit-card">{p.invoiceId}</div> : null,
}));
vi.mock('@/components/ui/QrPaymentModal', () => ({ QrPaymentModal: () => null }));
vi.mock('@/components/ui/date-picker-input', () => ({ DatePickerInput: () => null }));

import InvoicesPage from '../page';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <InvoicesPage />
    </QueryClientProvider>,
  );
}

let summary: { tables: { key: string; positions: number }[]; executors: [] } = {
  tables: [],
  executors: [],
};

async function openPanel() {
  renderPage();
  await screen.findAllByText('РАХ-0001');
  await screen.findByRole('button', { name: 'Сховати бокову панель' });
  fireEvent.click(tableRow('РАХ-0001'));
  await waitFor(() => expect(panelShows('РАХ-0001')).toBe(true));
}

describe('Рахунки — «Надіслати» в панелі для чернетки без рядків (BR-INV-023)', () => {
  beforeEach(() => {
    urlStore.reset();
    localStorage.clear();
    listItems = [INV_A, INV_B];
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/lines-summary')) return Promise.resolve(summary);
      if (path === `/invoices/${INV_A.id}`) return Promise.resolve({ ...INV_A, lines: [] });
      return Promise.resolve({});
    });
  });

  // guards: BR-INV-023
  it('без рядків — «Надіслати» неактивна, видно підказку, переходу немає', async () => {
    summary = { tables: [], executors: [] };
    await openPanel();
    const send = await screen.findByRole('button', { name: 'Надіслати' });
    await waitFor(() => expect(send).toBeDisabled());
    expect(screen.getByTestId('send-no-lines')).toBeInTheDocument();
    fireEvent.click(send);
    expect(apiFetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/transition'),
      expect.anything(),
    );
  });

  // guards: BR-INV-023
  it('з рядком — «Надіслати» активна, без підказки', async () => {
    summary = { tables: [{ key: 'other', positions: 1 }], executors: [] };
    await openPanel();
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/lines-summary'),
        expect.anything(),
      ),
    );
    const send = await screen.findByRole('button', { name: 'Надіслати' });
    expect(send).not.toBeDisabled();
    expect(screen.queryByTestId('send-no-lines')).toBeNull();
  });
});
