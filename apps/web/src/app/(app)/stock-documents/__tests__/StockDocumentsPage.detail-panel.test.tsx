// Бокова панель списку складських документів (рішення власника 2026-10-13) — стандарт списків:
//
//   - панель УВІМКНЕНА → клік по рядку вибирає рядок і показує панель (поля шапки зі схеми,
//     «Зведення», кнопка «Відкрити документ»), картка редагування НЕ відкривається;
//   - панель ВИМКНЕНА → клік по рядку одразу відкриває картку редагування, як було;
//   - олівець у рядку в обох режимах відкриває те саме, що й до панелі, — вікно перегляду;
//   - «Відкрити документ» у панелі відкриває картку редагування;
//   - вимкнули панель → вибір скидається (після повторного вмикання клік знову ВІДКРИВАЄ панель).
//
// Mutation-verify: прибрати `if (detailPanel.enabled)` з onClick рядка → падають кейси
// «не відкриває картку» / «вимкнена → картка».

import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { StockDoc } from '@/hooks/api/useStockDocuments';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/stock-documents',
}));
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
  useAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
}));

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const DOC: StockDoc = {
  id: 'doc-1',
  orgId: 'org-1',
  number: 'СП-0001',
  type: 'WRITEOFF',
  status: 'DRAFT',
  branchId: 'b-1',
  branchName: 'Головна філія',
  warehouseId: 'w-1',
  warehouseName: 'Основний склад',
  targetWarehouseId: null,
  targetWarehouseName: null,
  notes: 'Бій при розвантаженні',
  confirmedAt: null,
  documentDate: '2026-10-13T00:00:00.000Z',
  lines: [],
  linesCount: 3,
  createdAt: '2026-10-13T08:00:00.000Z',
  updatedAt: '2026-10-13T08:00:00.000Z',
  deletedAt: null,
};
const DOC_2: StockDoc = { ...DOC, id: 'doc-2', number: 'СП-0002', notes: null };
// Що зараз віддає список: тест «рядок зник зі списку» міняє сторінку / фільтр через цю змінну.
let listItems: StockDoc[] = [DOC, DOC_2];

vi.mock('@/hooks/api/useStockDocuments', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/useStockDocuments')>();
  return {
    ...actual,
    useStockDocuments: () => ({
      data: { items: listItems, total: listItems.length, page: 1, limit: 20 },
      isLoading: false,
    }),
  };
});
vi.mock('../StockMovementsTab', () => ({ StockMovementsTab: () => null }));
// Картка редагування — маркер із id документа, з яким її відкрили.
vi.mock('@/components/ui/StockDocumentCreateModal', () => ({
  StockDocumentCreateModal: (p: { open: boolean; stockDocumentId?: string }) =>
    p.open && p.stockDocumentId ? <div data-testid="edit-card">{p.stockDocumentId}</div> : null,
}));
vi.mock('@/components/ui/date-picker-input', () => ({
  DatePickerInput: () => null,
}));

import StockDocumentsPage from '../page';

const PANEL_KEY = 'sto_detail_panel_stock-documents';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = () => (
    <QueryClientProvider client={client}>
      <StockDocumentsPage />
    </QueryClientProvider>
  );
  const utils = render(ui());
  return { ...utils, rerenderPage: () => utils.rerender(ui()) };
}

// Номер стоїть і в рядку таблиці, і в заголовку відкритої панелі — беремо саме рядок.
const row = (number: string) =>
  screen
    .getAllByText(number)
    .map(el => el.closest('tr'))
    .find(tr => tr !== null)!;
const summaryCalls = () =>
  apiFetchMock.mock.calls.map(c => c[0] as string).filter(p => p.endsWith('/lines-summary'));

describe('Складські документи — бокова панель', () => {
  beforeEach(() => {
    localStorage.clear();
    listItems = [DOC, DOC_2];
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/lines-summary')) {
        return Promise.resolve({
          tables: [
            { key: 'goods', positions: 3, distinct: 2, quantity: 7.5, quantityUnit: 'units' },
          ],
          executors: [],
        });
      }
      if (path === '/stock-documents/doc-1') return Promise.resolve({ ...DOC });
      return Promise.resolve({});
    });
  });

  it('панель увімкнена (типово): клік по рядку показує панель і НЕ відкриває картку', async () => {
    renderPage();
    await screen.findByText('СП-0001');
    expect(screen.queryByTestId('lines-summary')).not.toBeInTheDocument();

    fireEvent.click(row('СП-0001'));

    const summary = await screen.findByTestId('lines-summary');
    expect(await within(summary).findByTestId('lines-summary-goods')).toHaveTextContent(
      '2 найменування · 7,5 од. · 3 рядки',
    );
    expect(summaryCalls()).toEqual(['/stock-documents/doc-1/lines-summary']);
    expect(screen.queryByTestId('edit-card')).not.toBeInTheDocument();
    expect(row('СП-0001')).toHaveClass('bg-primary/5');
    expect(row('СП-0002')).not.toHaveClass('bg-primary/5');
  });

  it('поля панелі — зі схеми STOCK_DOC_PANEL_SCHEMA, значення з рядка списку', async () => {
    renderPage();
    await screen.findByText('СП-0001');
    fireEvent.click(row('СП-0001'));
    await screen.findByTestId('lines-summary');

    const panel = screen.getByTestId('lines-summary').parentElement!;
    for (const label of ['Тип', 'Статус', 'Склад-джерело', 'Філія', 'Позицій', 'Нотатки']) {
      expect(within(panel).getByText(label)).toBeInTheDocument();
    }
    expect(within(panel).getByText('Головна філія')).toBeInTheDocument();
    expect(within(panel).getByText('Бій при розвантаженні')).toBeInTheDocument();
    // Блок зведення стоїть нижче полів шапки і вище кнопки «Відкрити документ».
    const notes = within(panel).getByText('Нотатки');
    const summary = screen.getByTestId('lines-summary');
    const open = within(panel).getByRole('button', { name: 'Відкрити документ' });
    expect(notes.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(summary.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('клік по іншому рядку перемикає панель; повторний клік по вибраному — закриває', async () => {
    renderPage();
    await screen.findByText('СП-0001');
    fireEvent.click(row('СП-0001'));
    await screen.findByTestId('lines-summary');

    fireEvent.click(row('СП-0002'));
    await waitFor(() =>
      expect(summaryCalls()).toEqual([
        '/stock-documents/doc-1/lines-summary',
        '/stock-documents/doc-2/lines-summary',
      ]),
    );
    expect(row('СП-0002')).toHaveClass('bg-primary/5');
    expect(row('СП-0001')).not.toHaveClass('bg-primary/5');

    fireEvent.click(row('СП-0002'));
    expect(screen.queryByTestId('lines-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('edit-card')).not.toBeInTheDocument();
  });

  it('«Відкрити документ» у панелі відкриває картку редагування цього документа', async () => {
    renderPage();
    await screen.findByText('СП-0001');
    fireEvent.click(row('СП-0001'));
    await screen.findByTestId('lines-summary');

    fireEvent.click(screen.getByRole('button', { name: 'Відкрити документ' }));
    expect(screen.getByTestId('edit-card')).toHaveTextContent('doc-1');
  });

  it('панель вимкнена: клік по рядку відкриває картку, панель і зведення не з’являються', async () => {
    localStorage.setItem(PANEL_KEY, 'false');
    renderPage();
    await screen.findByText('СП-0001');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Показати бокову панель' })).toBeInTheDocument(),
    );

    fireEvent.click(row('СП-0001'));

    expect(screen.getByTestId('edit-card')).toHaveTextContent('doc-1');
    expect(screen.queryByTestId('lines-summary')).not.toBeInTheDocument();
    expect(summaryCalls()).toEqual([]);
  });

  it.each([
    ['увімкнена', null],
    ['вимкнена', 'false'],
  ])('олівець (панель %s) відкриває вікно перегляду, а не панель і не картку', async (_n, ls) => {
    if (ls) localStorage.setItem(PANEL_KEY, ls);
    renderPage();
    await screen.findByText('СП-0001');
    if (ls) await screen.findByRole('button', { name: 'Показати бокову панель' });

    fireEvent.click(within(row('СП-0001')).getByTitle('Відкрити деталі'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('СП-0001');
    expect(screen.queryByTestId('edit-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lines-summary')).not.toBeInTheDocument();
  });

  it('вимкнули панель тоглом → вибір скинуто: після вмикання клік по тому ж рядку ВІДКРИВАЄ панель', async () => {
    renderPage();
    await screen.findByText('СП-0001');
    fireEvent.click(row('СП-0001'));
    await screen.findByTestId('lines-summary');

    fireEvent.click(screen.getByRole('button', { name: 'Сховати бокову панель' }));
    expect(screen.queryByTestId('lines-summary')).not.toBeInTheDocument();
    expect(localStorage.getItem(PANEL_KEY)).toBe('false');
    expect(row('СП-0001')).not.toHaveClass('bg-primary/5');

    fireEvent.click(screen.getByRole('button', { name: 'Показати бокову панель' }));
    fireEvent.click(row('СП-0001'));
    expect(await screen.findByTestId('lines-summary')).toBeInTheDocument();
    expect(screen.queryByTestId('edit-card')).not.toBeInTheDocument();
  });

  // Mutation-verify: прибрати ефект «рядок зник із завантаженого списку → setSelectedDocId(null)»
  // → останнє твердження падає (панель відкривається сама, щойно рядок повернувся у список).
  it('рядок зник зі списку (сторінка / фільтр) → панель закрита і НЕ відкривається сама, коли він повернувся', async () => {
    const { rerenderPage } = renderPage();
    await screen.findByText('СП-0001');
    fireEvent.click(row('СП-0001'));
    await screen.findByTestId('lines-summary');

    listItems = [DOC_2];
    rerenderPage();
    await waitFor(() => expect(screen.queryByTestId('lines-summary')).not.toBeInTheDocument());

    listItems = [DOC, DOC_2];
    rerenderPage();
    await screen.findByText('СП-0001');
    expect(screen.queryByTestId('lines-summary')).not.toBeInTheDocument();
    expect(row('СП-0001')).not.toHaveClass('bg-primary/5');
    // Контроль: вибір справді скинуто, а не «залип» — клік ВІДКРИВАЄ панель, а не закриває.
    fireEvent.click(row('СП-0001'));
    expect(await screen.findByTestId('lines-summary')).toBeInTheDocument();
  });
});
