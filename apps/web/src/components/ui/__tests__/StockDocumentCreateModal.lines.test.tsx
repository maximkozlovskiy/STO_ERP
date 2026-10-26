// Рішення власника №29 (TECH-DEBT §8 L774): у картці складського документа — колонка «Артикул»
// (`goodSku` приходить з API рядка) і під таблицею проведеного документа — «Проведено: дата й час»
// (`confirmedAt`). Кількість — через `fmtQty` (кома, без хвоста float), як у решті карток.
//
// Мутації (перевірено): не брати `goodSku` із завантаженого рядка → падає «артикул»; на один
// `<col>` менше (стара таблиця) → падає «colgroup»; `String(line.quantity)` замість
// `fmtQty(qty)` → падає «кількість»; прибрати рядок «Проведено» → падають «проведений» і «після
// проведення»; не брати `confirmedAt` з відповіді переходу → падає «після проведення»; не
// передавати `goodSku` з пікера → падає «новий рядок».

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { StockDocumentCreateModal } from '../StockDocumentCreateModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/components/ui/xlsx-import-button', () => ({ XlsxImportButton: () => null }));
vi.mock('@/components/ui/ExcelImportWizard', () => ({ ExcelImportWizard: () => null }));

const DOC = 'sd-1';
const TRANSITION = `/stock-documents/${DOC}/transition`;
// 09:15 UTC 20.10.2026 — у Києві ще літній час (UTC+3): 12:15.
const CONFIRMED_AT = '2026-10-20T09:15:00.000Z';

const LINES = [
  {
    id: 'l1',
    goodId: 'g1',
    goodName: 'Фільтр оливний',
    goodSku: 'W 712/75',
    unit: 'шт',
    quantity: 1.5,
    price: 10,
  },
  { id: 'l2', goodId: 'g2', goodName: 'Хомут', goodSku: null, unit: 'шт', quantity: 2, price: 5 },
];

function mockApi(doc: Record<string, unknown>) {
  apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/branches') return Promise.resolve([{ id: 'b1', name: 'Філія №1' }]);
    if (path === '/warehouses') {
      return Promise.resolve([{ id: 'w1', name: 'Склад №1', deletedAt: null }]);
    }
    if (path === `/stock-documents/${DOC}?withDeleted=true`) return Promise.resolve(doc);
    if (path === TRANSITION && init?.method === 'POST') {
      return Promise.resolve({ ...doc, status: 'CONFIRMED', confirmedAt: CONFIRMED_AT });
    }
    if (path.startsWith('/goods?')) {
      return Promise.resolve({
        items: [{ id: 'g9', name: 'Свічка запалювання', sku: 'BKR6E', unit: 'шт' }],
      });
    }
    return Promise.resolve({ items: [] });
  });
}

const baseDoc = (over: Record<string, unknown> = {}) => ({
  id: DOC,
  number: 'ПРХ-000001',
  status: 'DRAFT',
  type: 'RECEIPT',
  branchId: 'b1',
  warehouseId: 'w1',
  documentDate: '2026-10-13',
  confirmedAt: null,
  deletedAt: null,
  lines: LINES,
  ...over,
});

const cellsOf = async (name: string) => {
  const row = (await screen.findByText(name, undefined, { timeout: 2000 })).closest(
    'tr',
  ) as HTMLElement;
  return within(row)
    .getAllByRole('cell')
    .map(c => c.textContent);
};

function openCard() {
  render(<StockDocumentCreateModal open stockDocumentId={DOC} onClose={vi.fn()} />);
}

describe('Картка складського документа — артикул, кількість, час проведення', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('артикул: колонка «АРТИКУЛ» після товару; без артикулу — «—»', async () => {
    mockApi(baseDoc());
    openCard();
    const filter = await cellsOf('Фільтр оливний');
    expect(filter[1]).toBe('W 712/75');
    expect((await cellsOf('Хомут'))[1]).toBe('—');
    const headers = screen.getAllByRole('columnheader').map(h => h.textContent);
    expect(headers.slice(0, 3)).toEqual(['ТОВАР', 'АРТИКУЛ', 'ОВ']);
  });

  it('colgroup: стільки ж колонок, скільки заголовків', async () => {
    mockApi(baseDoc());
    openCard();
    const table = (await screen.findByText('Фільтр оливний')).closest('table')!;
    expect(table.querySelectorAll('colgroup > col')).toHaveLength(
      table.querySelectorAll('thead th').length,
    );
  });

  it('кількість — через fmtQty: 1,5, а не 1.5', async () => {
    mockApi(baseDoc());
    openCard();
    expect((await cellsOf('Фільтр оливний'))[3]).toBe('1,5');
  });

  it('проведений документ: під таблицею «Проведено: дата й час» за Києвом', async () => {
    mockApi(baseDoc({ status: 'CONFIRMED', confirmedAt: CONFIRMED_AT }));
    openCard();
    expect(await screen.findByText('Проведено: 20.10.2026, 12:15')).toBeInTheDocument();
  });

  it('чернетка: рядка «Проведено» немає', async () => {
    mockApi(baseDoc());
    openCard();
    await screen.findByText('Фільтр оливний');
    expect(screen.queryByText(/Проведено:/)).not.toBeInTheDocument();
  });

  it('після проведення в картці — «Проведено» з часом із відповіді сервера', async () => {
    mockApi(baseDoc());
    const user = userEvent.setup();
    openCard();
    await screen.findByText('Фільтр оливний');
    await user.click(screen.getByRole('button', { name: 'Підтвердити' }));
    const dialog = await waitFor(() => {
      const d = screen.getAllByRole('dialog').find(x => /Бажаєте/.test(x.textContent ?? ''));
      expect(d).toBeTruthy();
      return d!;
    });
    await user.click(within(dialog).getByRole('button', { name: 'Так' }));
    expect(await screen.findByText('Проведено: 20.10.2026, 12:15')).toBeInTheDocument();
  });

  it('новий рядок: артикул обраного товару видно в рядку введення', async () => {
    mockApi(baseDoc({ lines: [] }));
    const user = userEvent.setup();
    openCard();
    await user.click(await screen.findByRole('button', { name: 'Додати' }, { timeout: 2000 }));
    await user.click(await screen.findByText('Оберіть товар…'));
    await user.click(await screen.findByText('Свічка запалювання', undefined, { timeout: 2000 }));
    const row = (await screen.findByText('Свічка запалювання')).closest('tr') as HTMLElement;
    expect(within(row).getAllByRole('cell')[1]).toHaveTextContent('BKR6E');
  });
});
