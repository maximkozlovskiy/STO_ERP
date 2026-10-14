// Рахунки — стандарт кліку по рядку (рішення власника 2026-10-13). До цього клік по рядку одразу
// відкривав картку, а олівець — бокову панель: навпаки, ніж у складі й закупівлях.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import {
  itFollowsRowClickStandard,
  tableRow,
  panelShows,
} from '../../../../__tests__/row-click-standard';

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
  deletedAt: null as string | null,
};
const INV_B = { ...INV_A, id: 'inv-b', number: 'РАХ-0002', counterpartyName: 'Клієнт Другий' };
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

const card = () => screen.queryByTestId('edit-card');

describe('Рахунки — стандарт кліку по рядку', () => {
  beforeEach(() => {
    localStorage.clear();
    listItems = [INV_A, INV_B];
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/invoices/inv-a') return Promise.resolve({ ...INV_A, lines: [] });
      if (path === '/invoices/inv-b') return Promise.resolve({ ...INV_B, lines: [] });
      if (path.endsWith('/lines-summary')) return Promise.resolve({ tables: [], executors: [] });
      return Promise.resolve({});
    });
  });

  itFollowsRowClickStandard({
    renderPage,
    panelKey: 'invoices',
    rowText: 'РАХ-0001',
    panelTitle: 'РАХ-0001',
    pencil: row => within(row).getByTitle('Відкрити документ'),
    panelButton: 'Відкрити документ',
    isCardOpen: () => card()?.textContent === 'inv-a',
  });

  it('чекбокс рядка і колонка «Документи» рядок не вибирають і картку не відкривають', async () => {
    renderPage();
    await screen.findByText('РАХ-0001');

    fireEvent.click(within(tableRow('РАХ-0001')).getByRole('checkbox'));

    expect(panelShows('РАХ-0001')).toBe(false);
    expect(card()).not.toBeInTheDocument();
  });

  // Картка лише на перегляд: олівець і кнопка панелі мають працювати й для видаленого рядка.
  it('рядок, позначений на видалення: олівець відкриває картку; панель довантажує його з withDeleted', async () => {
    listItems = [{ ...INV_A, deletedAt: '2026-10-13T09:00:00.000Z' }, INV_B];
    renderPage();
    await screen.findByText('РАХ-0001');

    fireEvent.click(tableRow('РАХ-0001'));
    await waitFor(() => expect(panelShows('РАХ-0001')).toBe(true));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/invoices/inv-a?withDeleted=true'),
    );

    fireEvent.click(within(tableRow('РАХ-0001')).getByTitle('Відкрити документ'));
    expect(card()).toHaveTextContent('inv-a');
  });

  // BR-WO-012: панель видаленого рахунку — лише перегляд. Сервер на переходи, PDF і дублювання
  // такого рахунку відповідає 404, тож цих кнопок немає; «Друк» (window.print) і вхід у картку є.
  // Шукаємо в межах панелі: «Відкрити документ» — ще й назва олівця в рядку таблиці.
  const panelActions = () => {
    const heading = screen
      .getAllByRole('heading', { level: 2 })
      .find(h => h.textContent === 'РАХ-0001')!;
    const panel = within(heading.closest<HTMLElement>('.rounded-xl')!);
    return [
      'Надіслати',
      'Скасувати',
      'Завантажити PDF',
      'Дублювати',
      'Друк',
      'Відкрити документ',
    ].filter(name => panel.queryAllByRole('button', { name }).length > 0);
  };

  it('панель видаленого рядка: без «Надіслати / Скасувати / Завантажити PDF / Дублювати»', async () => {
    const deleted = { ...INV_A, deletedAt: '2026-10-13T09:00:00.000Z' };
    listItems = [deleted, INV_B];
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/invoices/inv-a?withDeleted=true') {
        return Promise.resolve({ ...deleted, lines: [] });
      }
      if (path.endsWith('/lines-summary')) return Promise.resolve({ tables: [], executors: [] });
      return Promise.resolve({});
    });
    renderPage();
    await screen.findByText('РАХ-0001');

    fireEvent.click(tableRow('РАХ-0001'));
    await waitFor(() => expect(panelShows('РАХ-0001')).toBe(true));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/invoices/inv-a?withDeleted=true'),
    );

    await waitFor(() => expect(panelActions()).toEqual(['Друк', 'Відкрити документ']));
  });

  it('контроль: панель звичайної чернетки має всі дії', async () => {
    renderPage();
    await screen.findByText('РАХ-0001');

    fireEvent.click(tableRow('РАХ-0001'));
    await waitFor(() => expect(panelShows('РАХ-0001')).toBe(true));

    await waitFor(() =>
      expect(panelActions()).toEqual([
        'Надіслати',
        'Скасувати',
        'Завантажити PDF',
        'Дублювати',
        'Друк',
        'Відкрити документ',
      ]),
    );
  });
});
