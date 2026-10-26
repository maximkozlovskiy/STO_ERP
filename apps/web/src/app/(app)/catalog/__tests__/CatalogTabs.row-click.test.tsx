// Каталог (роботи, товари, послуги) — стандарт кліку по рядку (рішення власника 2026-10-13).
// До цього з вимкненою панеллю клік нічого не робив, а в панелі не було кнопки відкриття картки.
// Рядки, позначені на видалення, і далі не клікабельні — це довідники, картки лише на перегляд
// для них немає.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import {
  itFollowsRowClickStandard,
  tableRow,
  panelShows,
} from '../../../../__tests__/row-click-standard';

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
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/components/ui/xlsx-import-button', () => ({ XlsxImportButton: () => null }));
// Картка товару — маркер із id товару, з яким її відкрили; «mock-save» — збереження картки
// (onSaved), щоб перевірити оновлення панелі.
vi.mock('@/components/ui/GoodEditModal', () => ({
  GoodEditModal: (p: {
    open: boolean;
    good?: { id: string } | null;
    onSaved: (g: unknown) => void;
  }) =>
    p.open && p.good ? (
      <>
        <div data-testid="good-card">{p.good.id}</div>
        <button onClick={() => p.onSaved(p.good)}>mock-save</button>
      </>
    ) : null,
}));

import WorksTab from '../WorksTab';
import GoodsTab from '../GoodsTab';
import ServicesTab from '../ServicesTab';

const DELETED_AT = '2026-10-13T09:00:00.000Z';

const WORK_A = {
  id: 'work-a',
  name: 'Заміна колодок',
  categoryId: null,
  categoryName: null,
  normoHours: 1.5,
  price: 600,
  description: null,
  isWarranty: false,
  deletedAt: null as string | null,
};
const WORK_B = { ...WORK_A, id: 'work-b', name: 'Заміна мастила' };

const GOOD_A = {
  id: 'good-a',
  internalCode: 'G-1',
  sku: 'F-1',
  brandName: null,
  name: 'Фільтр масляний',
  unit: 'шт',
  unitId: null,
  purchasePrice: 100,
  salePrice: 150,
  category: null,
  barcode: null,
  brandId: null,
  notes: null,
  deletedAt: null as string | null,
};
const GOOD_B = { ...GOOD_A, id: 'good-b', name: 'Фільтр повітряний', sku: 'F-2' };

const SERVICE_A = {
  id: 'service-a',
  name: 'ТО-1',
  description: null,
  price: 1200,
  works: [] as unknown[],
  goods: [] as unknown[],
  deletedAt: null as string | null,
};
const SERVICE_B = { ...SERVICE_A, id: 'service-b', name: 'ТО-2' };

let works = [WORK_A, WORK_B];
let goods = [GOOD_A, GOOD_B];
let services = [SERVICE_A, SERVICE_B];

const page = <T,>(items: T[]) => ({ items, total: items.length, page: 1, limit: 30 });

function renderTab(tab: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{tab}</QueryClientProvider>);
}

/** Відкрита вбудована картка редагування: діалог із цим заголовком і назвою рядка в полі. */
const inlineCardOpen = (title: string, name: string) =>
  screen.queryAllByRole('dialog').some(
    d =>
      (d.textContent ?? '').includes(title) &&
      within(d)
        .queryAllByRole('textbox')
        .some(i => (i as HTMLInputElement).value === name),
  );

beforeEach(() => {
  localStorage.clear();
  works = [WORK_A, WORK_B];
  goods = [GOOD_A, GOOD_B];
  services = [SERVICE_A, SERVICE_B];
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string) => {
    if (path.startsWith('/works?')) return Promise.resolve(page(works));
    if (path.startsWith('/goods?')) return Promise.resolve(page(goods));
    if (path.startsWith('/services?')) return Promise.resolve(page(services));
    if (path.startsWith('/brands') || path.startsWith('/counterparties')) {
      return Promise.resolve({ items: [], total: 0 });
    }
    return Promise.resolve([]);
  });
});

// Олівець у рядках каталогу — кнопка без назви: беремо за іконкою.
const pencil = (row: HTMLElement) =>
  row.querySelector<SVGElement>('svg.lucide-pencil')!.closest('button')!;

describe('Каталог → Роботи — стандарт кліку по рядку', () => {
  const cardOpen = () => inlineCardOpen('Редагування роботи', 'Заміна колодок');

  itFollowsRowClickStandard({
    renderPage: () => renderTab(<WorksTab />),
    panelKey: 'catalog-works',
    rowText: 'Заміна колодок',
    panelTitle: 'Заміна колодок',
    pencil,
    panelButton: 'Відкрити картку',
    isCardOpen: cardOpen,
  });

  it.each([
    ['увімкнена', null],
    ['вимкнена', 'false'],
  ])('видалений рядок (панель %s) не клікабельний: ні панелі, ні картки', async (_n, ls) => {
    if (ls) localStorage.setItem('sto_detail_panel_catalog-works', ls);
    works = [{ ...WORK_A, deletedAt: DELETED_AT }, WORK_B];
    renderTab(<WorksTab />);
    await screen.findByText('Заміна колодок');
    await screen.findByRole('button', {
      name: ls ? 'Показати бокову панель' : 'Сховати бокову панель',
    });

    fireEvent.click(tableRow('Заміна колодок'));

    expect(panelShows('Заміна колодок')).toBe(false);
    expect(cardOpen()).toBe(false);
    expect(tableRow('Заміна колодок')).not.toHaveClass('cursor-pointer');
  });
});

describe('Каталог → Товари — стандарт кліку по рядку', () => {
  const cardOpen = () => screen.queryByTestId('good-card')?.textContent === 'good-a';

  itFollowsRowClickStandard({
    renderPage: () => renderTab(<GoodsTab />),
    panelKey: 'catalog-goods',
    rowText: 'Фільтр масляний',
    panelTitle: 'Фільтр масляний',
    pencil,
    panelButton: 'Відкрити картку',
    isCardOpen: cardOpen,
  });

  it('видалений рядок не клікабельний: ні панелі, ні картки', async () => {
    localStorage.setItem('sto_detail_panel_catalog-goods', 'false');
    goods = [{ ...GOOD_A, deletedAt: DELETED_AT }, GOOD_B];
    renderTab(<GoodsTab />);
    await screen.findByText('Фільтр масляний');
    await screen.findByRole('button', { name: 'Показати бокову панель' });

    fireEvent.click(tableRow('Фільтр масляний'));

    expect(screen.queryByTestId('good-card')).not.toBeInTheDocument();
    expect(panelShows('Фільтр масляний')).toBe(false);
    expect(tableRow('Фільтр масляний')).not.toHaveClass('cursor-pointer');
  });

  // TECH-DEBT §8: панель тримала копію рядка і після збереження картки показувала старі дані.
  // Мутації: прибрати `useSelectedRowRefresh` у GoodsTab → падає заголовок; передати в хук
  // `selectGood` замість `setSelectedGood` → падає «штрихкоди не перечитуються».
  it('після збереження картки панель показує перечитаний рядок, вкладку «Штрихкоди» не скидає', async () => {
    renderTab(<GoodsTab />);
    await screen.findByText('Фільтр масляний');
    await screen.findByRole('button', { name: 'Сховати бокову панель' });

    fireEvent.click(tableRow('Фільтр масляний'));
    await waitFor(() => expect(panelShows('Фільтр масляний')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Штрихкоди' }));
    await screen.findByPlaceholderText('Штрихкод');
    const barcodeCalls = () =>
      apiFetchMock.mock.calls.filter(c => c[0] === '/goods/good-a/barcodes').length;
    const before = barcodeCalls();
    // Олівець рядка відкриває картку, вибір рядка й вкладка панелі лишаються.
    fireEvent.click(pencil(tableRow('Фільтр масляний')));
    await screen.findByTestId('good-card');

    goods = [{ ...GOOD_A, name: 'Фільтр масляний MANN' }, GOOD_B];
    fireEvent.click(screen.getByRole('button', { name: 'mock-save' }));

    await waitFor(() => expect(panelShows('Фільтр масляний MANN')).toBe(true));
    expect(panelShows('Фільтр масляний')).toBe(false);
    expect(screen.getByPlaceholderText('Штрихкод')).toBeInTheDocument();
    expect(barcodeCalls()).toBe(before);
  });
});

describe('Каталог → Послуги — стандарт кліку по рядку', () => {
  const cardOpen = () => inlineCardOpen('Редагування послуги', 'ТО-1');

  itFollowsRowClickStandard({
    renderPage: () => renderTab(<ServicesTab />),
    panelKey: 'catalog-services',
    rowText: 'ТО-1',
    panelTitle: 'ТО-1',
    pencil,
    panelButton: 'Відкрити картку',
    isCardOpen: cardOpen,
  });

  it('видалений рядок не клікабельний: ні панелі, ні картки', async () => {
    localStorage.setItem('sto_detail_panel_catalog-services', 'false');
    services = [{ ...SERVICE_A, deletedAt: DELETED_AT }, SERVICE_B];
    renderTab(<ServicesTab />);
    await screen.findByText('ТО-1');
    await screen.findByRole('button', { name: 'Показати бокову панель' });

    fireEvent.click(tableRow('ТО-1'));

    expect(cardOpen()).toBe(false);
    expect(panelShows('ТО-1')).toBe(false);
    expect(tableRow('ТО-1')).not.toHaveClass('cursor-pointer');
  });
});
