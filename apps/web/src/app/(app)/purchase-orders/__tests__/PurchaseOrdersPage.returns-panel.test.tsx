// Бокова панель вкладки «Повернення» сторінки закупівель (рішення власника 2026-10-13) і
// блок «Зведення» в панелі замовлень:
//
//   - панель повернень УВІМКНЕНА → клік по рядку вибирає його й показує панель (поля зі схеми
//     SUPPLIER_RETURN_PANEL_SCHEMA, «Зведення», «Відкрити документ»), картка НЕ відкривається;
//   - ВИМКНЕНА → клік відкриває картку повернення, як було;
//   - олівець відкриває картку в обох режимах;
//   - панелі замовлень і повернень мають ОКРЕМІ перемикачі (ключі localStorage різні) і не
//     заважають одна одній: вибір скидається при перемиканні вкладки;
//   - панель замовлення показує зведення з ендпоінта /purchase-orders/:id/lines-summary.
//
// Mutation-verify: прибрати `if (srDetailPanel.enabled)` з onClick рядка повернення → падають
// «НЕ відкриває картку» і «вимкнена → картка»; прибрати ефект на `activeTab` → падає кейс
// «перемикання вкладки скидає вибір».

import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { SupplierReturn } from '@/hooks/api/useSupplierReturns';
import type { PurchaseOrder } from '@/hooks/api/usePurchaseOrders';

// Рядок запиту сторінки — змінний: вкладку перемикає router.replace('?tab=…').
let search = 'tab=returns';
const replaceMock = vi.fn((url: string) => {
  search = url.replace(/^\?/, '');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => '/purchase-orders',
}));
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
  useAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
}));

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const SR: SupplierReturn = {
  id: 'sr-1',
  orgId: 'org-1',
  number: 'ПП-0001',
  status: 'DRAFT',
  supplierId: 's-1',
  supplierName: 'ТОВ «Автозапчастини»',
  warehouseId: 'w-1',
  warehouseName: 'Основний склад',
  purchaseOrderId: null,
  purchaseOrderNumber: null,
  totalAmount: 1250.5,
  notes: 'Брак',
  documentDate: '2026-10-13T00:00:00.000Z',
  linesCount: 2,
  lines: [],
  createdAt: '2026-10-10T08:00:00.000Z',
  updatedAt: '2026-10-13T08:00:00.000Z',
  deletedAt: null,
};
const SR_2: SupplierReturn = { ...SR, id: 'sr-2', number: 'ПП-0002', notes: null };

const PO: PurchaseOrder = {
  id: 'po-1',
  orgId: 'org-1',
  number: 'ЗП-0001',
  status: 'DRAFT',
  supplierId: 's-1',
  supplierName: 'ТОВ «Автозапчастини»',
  warehouseId: 'w-1',
  warehouseName: 'Основний склад',
  totalAmount: 900,
  totalVat: 0,
  linesCount: 1,
  lines: [],
  createdAt: '2026-10-13T08:00:00.000Z',
  updatedAt: '2026-10-13T08:00:00.000Z',
  deletedAt: null,
};

vi.mock('@/hooks/api/useSupplierReturns', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/useSupplierReturns')>();
  return {
    ...actual,
    useSupplierReturns: () => ({
      data: { items: [SR, SR_2], total: 2, page: 1, limit: 50 },
      isLoading: false,
    }),
  };
});
vi.mock('@/hooks/api/usePurchaseOrders', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/usePurchaseOrders')>();
  return {
    ...actual,
    usePurchaseOrders: () => ({
      data: { items: [PO], total: 1, page: 1, limit: 20 },
      isLoading: false,
      error: null,
    }),
  };
});
vi.mock('@/hooks/api/useCash', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/useCash')>();
  return { ...actual, useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }) };
});
// Картки — маркери з id документа, з яким їх відкрили.
vi.mock('@/components/ui/SupplierReturnCreateModal', () => ({
  SupplierReturnCreateModal: (p: { open: boolean; editId?: string | null }) =>
    p.open && p.editId ? <div data-testid="sr-card">{p.editId}</div> : null,
}));
vi.mock('@/components/ui/PurchaseOrderCreateModal', () => ({
  PurchaseOrderCreateModal: (p: { open: boolean; purchaseOrderId?: string }) =>
    p.open && p.purchaseOrderId ? <div data-testid="po-card">{p.purchaseOrderId}</div> : null,
}));
vi.mock('@/components/ui/date-picker-input', () => ({ DatePickerInput: () => null }));

import PurchaseOrdersPage from '../page';

const SR_PANEL_KEY = 'sto_detail_panel_supplier-returns';
const PO_PANEL_KEY = 'sto_detail_panel_purchase-orders';

function ui(client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <PurchaseOrdersPage />
    </QueryClientProvider>
  );
}
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(ui(client));
  return { ...utils, rerenderPage: () => utils.rerender(ui(client)) };
}

// Номер стоїть і в рядку таблиці, і в заголовку відкритої панелі — беремо саме рядок.
const row = (number: string) =>
  screen
    .getAllByText(number)
    .map(el => el.closest('tr'))
    .find(tr => tr !== null)!;
const summaryCalls = () =>
  apiFetchMock.mock.calls.map(c => c[0] as string).filter(p => p.endsWith('/lines-summary'));

describe('Закупівлі — бокова панель повернень і зведення', () => {
  beforeEach(() => {
    localStorage.clear();
    search = 'tab=returns';
    replaceMock.mockClear();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/lines-summary')) {
        return Promise.resolve({
          tables: [{ key: 'goods', positions: 2, distinct: 2, quantity: 5, quantityUnit: 'units' }],
          executors: [],
        });
      }
      if (path === '/purchase-orders/po-1') return Promise.resolve({ ...PO });
      return Promise.resolve({});
    });
  });

  it('повернення, панель увімкнена (типово): клік показує панель і НЕ відкриває картку', async () => {
    renderPage();
    await screen.findByText('ПП-0001');

    fireEvent.click(row('ПП-0001'));

    const summary = await screen.findByTestId('lines-summary');
    expect(await within(summary).findByTestId('lines-summary-goods')).toHaveTextContent(
      '2 найменування · 5 од.',
    );
    expect(summaryCalls()).toEqual(['/supplier-returns/sr-1/lines-summary']);
    expect(screen.queryByTestId('sr-card')).not.toBeInTheDocument();
    expect(row('ПП-0001')).toHaveClass('bg-primary/5');
    expect(row('ПП-0002')).not.toHaveClass('bg-primary/5');
  });

  it('поля панелі повернення — зі схеми: номер, статус, постачальник, склад, дата, сума, позицій', async () => {
    renderPage();
    await screen.findByText('ПП-0001');
    fireEvent.click(row('ПП-0001'));
    const panel = (await screen.findByTestId('lines-summary')).parentElement!;

    for (const label of [
      'Номер',
      'Статус',
      'Постачальник',
      'Склад',
      'Дата документа',
      'Сума',
      'Позицій',
    ]) {
      expect(within(panel).getByText(label)).toBeInTheDocument();
    }
    expect(within(panel).getByText('Чернетка')).toBeInTheDocument();
    expect(within(panel).getByText('Основний склад')).toBeInTheDocument();
    expect(within(panel).getByText(/1\s250,50 ₴/)).toBeInTheDocument();
    expect(within(panel).getByText('13.10.2026')).toBeInTheDocument();
  });

  it('«Відкрити документ» у панелі відкриває картку цього повернення', async () => {
    renderPage();
    await screen.findByText('ПП-0001');
    fireEvent.click(row('ПП-0001'));
    await screen.findByTestId('lines-summary');

    fireEvent.click(screen.getByRole('button', { name: 'Відкрити документ' }));
    expect(await screen.findByTestId('sr-card')).toHaveTextContent('sr-1');
  });

  it('повернення, панель вимкнена: клік відкриває картку; зведення не запитується', async () => {
    localStorage.setItem(SR_PANEL_KEY, 'false');
    renderPage();
    await screen.findByText('ПП-0001');
    await screen.findByRole('button', { name: 'Показати бокову панель' });

    fireEvent.click(row('ПП-0002'));

    expect(await screen.findByTestId('sr-card')).toHaveTextContent('sr-2');
    expect(screen.queryByTestId('lines-summary')).not.toBeInTheDocument();
    expect(summaryCalls()).toEqual([]);
  });

  it.each([
    ['увімкнена', null],
    ['вимкнена', 'false'],
  ])('олівець у рядку повернення (панель %s) відкриває картку, а не панель', async (_n, ls) => {
    if (ls) localStorage.setItem(SR_PANEL_KEY, ls);
    renderPage();
    await screen.findByText('ПП-0001');
    if (ls) await screen.findByRole('button', { name: 'Показати бокову панель' });

    fireEvent.click(screen.getByRole('button', { name: 'Відкрити повернення ПП-0001' }));

    expect(await screen.findByTestId('sr-card')).toHaveTextContent('sr-1');
    expect(screen.queryByTestId('lines-summary')).not.toBeInTheDocument();
  });

  it('перемикач панелі повернень пише у свій ключ і не чіпає панель замовлень', async () => {
    renderPage();
    await screen.findByText('ПП-0001');
    fireEvent.click(row('ПП-0001'));
    await screen.findByTestId('lines-summary');

    fireEvent.click(screen.getByRole('button', { name: 'Сховати бокову панель' }));

    expect(localStorage.getItem(SR_PANEL_KEY)).toBe('false');
    expect(localStorage.getItem(PO_PANEL_KEY)).toBeNull();
    expect(screen.queryByTestId('lines-summary')).not.toBeInTheDocument();
    // Вибір скинуто: після вмикання клік по тому самому рядку ВІДКРИВАЄ панель, а не закриває.
    fireEvent.click(screen.getByRole('button', { name: 'Показати бокову панель' }));
    fireEvent.click(row('ПП-0001'));
    expect(await screen.findByTestId('lines-summary')).toBeInTheDocument();
  });

  it('замовлення: панель показує зведення з /purchase-orders/:id/lines-summary', async () => {
    search = 'tab=orders';
    renderPage();
    await screen.findByText('ЗП-0001');

    fireEvent.click(row('ЗП-0001'));

    const summary = await screen.findByTestId('lines-summary');
    expect(await within(summary).findByTestId('lines-summary-goods')).toHaveTextContent(
      '2 найменування · 5 од.',
    );
    expect(summaryCalls()).toEqual(['/purchase-orders/po-1/lines-summary']);
    expect(screen.queryByTestId('po-card')).not.toBeInTheDocument();
    // Зведення — нижче полів шапки, вище кнопки «Відкрити замовлення».
    const open = screen.getByRole('button', { name: 'Відкрити замовлення' });
    expect(summary.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('перемикання вкладки скидає вибір в обох списках', async () => {
    const { rerenderPage } = renderPage();
    await screen.findByText('ПП-0001');
    fireEvent.click(row('ПП-0001'));
    await screen.findByTestId('lines-summary');

    fireEvent.click(screen.getByRole('button', { name: 'Замовлення постачальникам' }));
    expect(search).toContain('tab=orders');
    rerenderPage();
    await screen.findByText('ЗП-0001');
    expect(screen.queryByTestId('lines-summary')).not.toBeInTheDocument();

    fireEvent.click(row('ЗП-0001'));
    await screen.findByTestId('lines-summary');

    fireEvent.click(screen.getByRole('button', { name: 'Повернення постачальнику' }));
    rerenderPage();
    await screen.findByText('ПП-0001');
    // Попередній вибір повернення не «воскрес», панель закрита.
    expect(screen.queryByTestId('lines-summary')).not.toBeInTheDocument();
    expect(row('ПП-0001')).not.toHaveClass('bg-primary/5');

    fireEvent.click(screen.getByRole('button', { name: 'Замовлення постачальникам' }));
    rerenderPage();
    await screen.findByText('ЗП-0001');
    await waitFor(() => expect(screen.queryByTestId('lines-summary')).not.toBeInTheDocument());
    expect(row('ЗП-0001')).not.toHaveClass('bg-primary/5');
  });
});
