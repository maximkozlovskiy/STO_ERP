// Списки купівлі — пов'язані документи (BR-PL-020): колонка «Документи» таблиці показує лічильники з
// `POST /purchase-lists/linked-counts` і відкриває вікно документів; картка списку має вкладки
// «Основне» / «Документи», вкладка «Документи» — панель `purchaseListLinkedConfig` цього списку.
//
// Mutation-verify: колонка без `counts={linkedCounts[l.id]}` → «лічильники» падає; клік по
// лічильнику відкриває картку замість вікна (без stopPropagation) → «вікно документів» падає;
// вкладка не скидається на іншому списку → «інший список» падає; лічильник вкладки лише з відповіді
// панелі (без `usePurchaseListLinkedCounts([listId])`) → «до першого її відкриття» падає.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }) }));

const LISTS = [
  {
    id: 'pl-1',
    number: 'СК-1',
    name: 'Перший',
    status: 'OPEN',
    openCount: 1,
    orderedCount: 1,
    receivedCount: 0,
    warehouseName: null,
    mergedIntoNumber: null,
    createdAt: '2026-10-30T10:00:00.000Z',
  },
  {
    id: 'pl-2',
    number: 'СК-2',
    name: null,
    status: 'OPEN',
    openCount: 0,
    orderedCount: 0,
    receivedCount: 0,
    warehouseName: null,
    mergedIntoNumber: null,
    createdAt: '2026-10-30T11:00:00.000Z',
  },
];
const countsCalls: string[][] = [];

vi.mock('@/hooks/api/usePurchaseLists', () => ({
  usePurchaseLists: () => ({
    data: { items: LISTS, total: LISTS.length },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  usePurchaseListLinkedCounts: (ids: string[]) => {
    countsCalls.push([...ids]);
    return {
      'pl-1': { workOrders: 2, purchaseOrders: 1, purchaseLists: 0 },
      'pl-2': { workOrders: 0, purchaseOrders: 0, purchaseLists: 0 },
    };
  },
  usePurchaseListDetail: (id: string | null) => ({
    data: id ? { ...LISTS.find(l => l.id === id)!, items: [] } : undefined,
    isLoading: false,
    error: null,
  }),
  purchaseListsApi: {},
}));
vi.mock('@/hooks/api/useInfrastructure', () => ({ useWarehouses: () => ({ data: [] }) }));
vi.mock('@/components/ui/LinkedDocumentsPanel', () => ({
  LinkedDocumentsPanel: ({
    entityId,
    config,
  }: {
    entityId: string;
    config: { fetchPath: (id: string) => string };
  }) => <div data-testid="linked-panel">{config.fetchPath(entityId)}</div>,
}));
vi.mock('@/components/ui/LinkedDocumentsPopup', () => ({
  LinkedDocumentsPopup: ({
    entityId,
    config,
  }: {
    entityId: string;
    config: { fetchPath: (id: string) => string };
  }) => <div data-testid="linked-popup">{config.fetchPath(entityId)}</div>,
}));

import { ListsView } from '../ListsView';

function renderView(openListId: string | null = null) {
  const client = new QueryClient();
  const ui = (id: string | null) => (
    <QueryClientProvider client={client}>
      <ListsView canWrite openListId={id} />
    </QueryClientProvider>
  );
  const r = render(ui(openListId));
  return { rerender: (id: string | null) => r.rerender(ui(id)) };
}

beforeEach(() => {
  countsCalls.length = 0;
});

describe('Списки купівлі — пов’язані документи (BR-PL-020)', () => {
  // guards: BR-PL-020
  it('колонка «Документи» — лічильники рядка; один запит на відсортовані id сторінки', () => {
    renderView();
    const row = screen.getAllByTestId('purchase-list-row')[0]!;
    expect(within(row).getByTitle('Наряди: 2')).toHaveTextContent('2');
    expect(within(row).getByTitle('Замовлення постачальнику: 1')).toBeInTheDocument();
    expect(within(row).queryByTitle(/Обʼєднані списки/)).toBeNull();
    // Таблиця — один набір на відсортовані id сторінки (картка списку питає лише свій id).
    expect(countsCalls).toContainEqual(['pl-1', 'pl-2']);
  });

  // guards: BR-PL-020
  it('клік по лічильнику — вікно документів цього списку, а не картка', () => {
    renderView();
    fireEvent.click(screen.getByTitle('Наряди: 2'));
    expect(screen.getByTestId('linked-popup')).toHaveTextContent(
      '/purchase-lists/pl-1/linked-documents',
    );
    expect(screen.queryByRole('tab', { name: /^Документи/ })).toBeNull();
  });

  // guards: BR-PL-020
  it('картка: «Основне» за замовчуванням, вкладка «Документи» — панель цього списку', () => {
    renderView();
    fireEvent.click(screen.getAllByTestId('purchase-list-row')[0]!);
    expect(screen.getByRole('tab', { name: 'Основне' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('linked-panel')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /^Документи/ }));
    expect(screen.getByTestId('linked-panel')).toHaveTextContent(
      '/purchase-lists/pl-1/linked-documents',
    );
  });

  // guards: BR-PL-020 — число на вкладці видно одразу, а не лише після першого відкриття вкладки.
  it('картка: лічильник на вкладці «Документи» — до першого її відкриття', () => {
    renderView();
    fireEvent.click(screen.getAllByTestId('purchase-list-row')[0]!);
    expect(screen.getByRole('tab', { name: /^Документи/ })).toHaveTextContent(/Документи\s*3$/);
    expect(countsCalls).toContainEqual(['pl-1']);
  });

  it('інший список у тій самій картці (перехід з «Обʼєднаних списків») — знову «Основне»', () => {
    const { rerender } = renderView('pl-1');
    fireEvent.click(screen.getByRole('tab', { name: /^Документи/ }));
    expect(screen.getByTestId('linked-panel')).toBeInTheDocument();

    rerender('pl-2');
    expect(screen.getByRole('tab', { name: 'Основне' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('linked-panel')).toBeNull();
  });
});
