// Оплати постачальникам — стандарт кліку по рядку (рішення власника 2026-10-13). До цього з
// вимкненою панеллю клік нічого не робив, у панелі не було кнопки відкриття, а в рядка,
// позначеного на видалення, не було й олівця — видалену оплату не можна було навіть переглянути.
//
// «Відкрити» тут двояке: чернетка редагується у модалці, решта — картка-сторінка
// `/supplier-payments/[id]`; видалена чернетка теж іде на сторінку (там вона лише на перегляд).

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import {
  itFollowsRowClickStandard,
  tableRow,
  panelShows,
} from '../../../../__tests__/row-click-standard';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: pushMock }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/supplier-payments',
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
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));
vi.mock('@/components/ui/date-picker-input', () => ({ DatePickerInput: () => null }));
vi.mock('../SupplierPaymentScheduleTab', () => ({ SupplierPaymentScheduleTab: () => null }));
// Модалка редагування чернетки — маркер із id оплати.
vi.mock('@/components/ui/SupplierPaymentCreateModal', () => ({
  SupplierPaymentCreateModal: (p: { open: boolean; paymentId?: string }) =>
    p.open && p.paymentId ? <div data-testid="edit-card">{p.paymentId}</div> : null,
}));

const SP_DRAFT = {
  id: 'sp-a',
  orgId: 'org-1',
  number: 'ОП-0001',
  status: 'DRAFT',
  supplierId: 'sup-1',
  supplierName: 'Постачальник Перший',
  sourceType: 'CASH',
  sourceName: 'Каса',
  method: 'cash',
  amount: 500,
  purchaseOrderId: null,
  purchaseOrderNumber: null,
  documentDate: '2026-10-13T00:00:00.000Z',
  notes: null,
  createdAt: '2026-10-13T08:00:00.000Z',
  updatedAt: '2026-10-13T08:00:00.000Z',
  deletedAt: null as string | null,
};
const SP_CONFIRMED = { ...SP_DRAFT, id: 'sp-b', number: 'ОП-0002', status: 'CONFIRMED' };
let listItems = [SP_DRAFT, SP_CONFIRMED];

import SupplierPaymentsPage from '../page';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SupplierPaymentsPage />
    </QueryClientProvider>,
  );
}

const card = () => screen.queryByTestId('edit-card');
const waitPanelToggle = (enabled: boolean) =>
  screen.findByRole('button', {
    name: enabled ? 'Сховати бокову панель' : 'Показати бокову панель',
  });

describe('Оплати постачальникам — стандарт кліку по рядку', () => {
  beforeEach(() => {
    localStorage.clear();
    pushMock.mockReset();
    listItems = [SP_DRAFT, SP_CONFIRMED];
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path.startsWith('/supplier-payments?')) {
        return Promise.resolve({ items: listItems, total: listItems.length, page: 1, limit: 20 });
      }
      return Promise.resolve({});
    });
  });

  describe('чернетка → модалка редагування', () => {
    itFollowsRowClickStandard({
      renderPage,
      panelKey: 'supplier-payments',
      rowText: 'ОП-0001',
      panelTitle: 'ОП-0001',
      pencil: row => within(row).getByRole('button', { name: 'Редагувати оплату ОП-0001' }),
      panelButton: 'Відкрити документ',
      isCardOpen: () => card()?.textContent === 'sp-a',
    });
  });

  describe('проведена оплата → картка-сторінка', () => {
    itFollowsRowClickStandard({
      renderPage,
      panelKey: 'supplier-payments',
      rowText: 'ОП-0002',
      panelTitle: 'ОП-0002',
      pencil: row => within(row).getByRole('button', { name: 'Відкрити оплату ОП-0002' }),
      panelButton: 'Відкрити документ',
      isCardOpen: () => pushMock.mock.calls.some(c => c[0] === '/supplier-payments/sp-b'),
    });
  });

  describe('оплата, позначена на видалення', () => {
    beforeEach(() => {
      listItems = [{ ...SP_DRAFT, deletedAt: '2026-10-13T09:00:00.000Z' }, SP_CONFIRMED];
    });

    it('олівець є і веде на картку-сторінку (лише перегляд), а не в модалку редагування', async () => {
      renderPage();
      await screen.findByText('ОП-0001');
      const row = tableRow('ОП-0001');

      fireEvent.click(within(row).getByRole('button', { name: 'Відкрити оплату ОП-0001' }));

      expect(pushMock).toHaveBeenCalledWith('/supplier-payments/sp-a');
      expect(card()).not.toBeInTheDocument();
      // Дії зміни для видаленого рядка сховані.
      expect(within(row).queryByTitle('Помітити на видалення')).not.toBeInTheDocument();
    });

    it('панель вимкнена: клік по рядку веде на картку-сторінку', async () => {
      localStorage.setItem('sto_detail_panel_supplier-payments', 'false');
      renderPage();
      await screen.findByText('ОП-0001');
      await waitPanelToggle(false);

      fireEvent.click(tableRow('ОП-0001'));

      expect(pushMock).toHaveBeenCalledWith('/supplier-payments/sp-a');
      expect(card()).not.toBeInTheDocument();
    });

    it('у панелі є «Відкрити документ», а дій зміни (провести, скасувати) немає', async () => {
      renderPage();
      await screen.findByText('ОП-0001');
      await waitPanelToggle(true);

      fireEvent.click(tableRow('ОП-0001'));
      await waitFor(() => expect(panelShows('ОП-0001')).toBe(true));

      expect(screen.getByText('Відкрити документ')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Провести' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Скасувати' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('Відкрити документ'));
      expect(pushMock).toHaveBeenCalledWith('/supplier-payments/sp-a');
    });
  });

  it('контроль: у панелі живої чернетки дії зміни є', async () => {
    renderPage();
    await screen.findByText('ОП-0001');
    await waitPanelToggle(true);

    fireEvent.click(tableRow('ОП-0001'));
    await waitFor(() => expect(panelShows('ОП-0001')).toBe(true));

    expect(screen.getByRole('button', { name: 'Провести' })).toBeInTheDocument();
  });

  it('чекбокс рядка рядок не вибирає і документ не відкриває', async () => {
    renderPage();
    await screen.findByText('ОП-0001');

    fireEvent.click(within(tableRow('ОП-0001')).getByRole('checkbox'));

    expect(panelShows('ОП-0001')).toBe(false);
    expect(card()).not.toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
