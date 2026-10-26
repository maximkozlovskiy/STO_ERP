// Сума рядка й «Разом» у картках рахунку, замовлення постачальнику і складського документа —
// округлені до копійки так само, як їх пише сервер (`money(quantity * price)` на рядок, підсумок —
// сума округлених рядків). Сирий добуток давав розбіжність на копійку (клас Bug #811, виправлений
// у картці наряду; TECH-DEBT §8 «Знахідки tester-а після рішень щодо ПДВ»):
//   - 0,3 × 100,05 = 30,014999… → `toFixed(2)` = «30.01», збережено 30,02;
//   - три рядки 0,3 × 111,11 = 99,999 → «100.00», сервер — 99,99.
//
// Мутації (перевірено): повернути сирий `qty * price` у
//   - `total` рахунку → падає «рахунок: три рядки»;
//   - сумі рядка рахунку → падає «рахунок: рядок»;
//   - прев'ю нового рядка рахунку → падає «рахунок: новий рядок»;
//   - `computedTotal` створення рахунку → падає «рахунок: POST /invoices»;
//   - `lineSubtotal` замовлення → падає «замовлення: рядок»; `total` замовлення → «три рядки»;
//   - `total` / сумі рядка / прев'ю складського документа → падають відповідні кейси.

import { render, screen, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { InvoiceCreateModal } from '../InvoiceCreateModal';
import { PurchaseOrderCreateModal } from '../PurchaseOrderCreateModal';
import { StockDocumentCreateModal } from '../StockDocumentCreateModal';
import { renderWithQueryClient } from '../../../__tests__/query-utils';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role: 'OWNER' } }),
}));

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: vi.fn(),
}));

vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

vi.mock('@/components/ui/xlsx-import-button', () => ({
  XlsxImportButton: () => null,
}));
vi.mock('@/components/ui/ExcelImportWizard', () => ({
  ExcelImportWizard: () => null,
}));

const CP = '11111111-1111-4111-8111-111111111111';

/** Довідники порожні, документ `docPath` — `doc`. */
function mockApi(docPath: string, doc: Record<string, unknown>) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === docPath) return Promise.resolve(doc);
    if (path === '/branches') return Promise.resolve([{ id: 'b1', name: 'Філія №1' }]);
    if (path === '/warehouses') {
      return Promise.resolve([{ id: 'w1', name: 'Склад №1', deletedAt: null }]);
    }
    if (path === '/settings/organisation') {
      return Promise.resolve({ vatMode: 'NONE', defaultVatRateId: null });
    }
    if (path === '/settings/tax-rates') return Promise.resolve([]);
    if (path.endsWith('/linked-documents')) {
      return Promise.resolve({ invoices: [], payments: [], calendarSlots: [], warranties: [] });
    }
    return Promise.resolve({ items: [] });
  });
}

/** Рядок підсумку («Разом:») таблиці рядків. */
const totalRow = () => screen.getByText('Разом:').closest('tr') as HTMLElement;

/** Комірка «Сума» рядка з назвою `name` (індекс колонки — `col`). */
async function lineCell(name: string, col: number): Promise<string> {
  const row = (await screen.findByText(name, undefined, { timeout: 2000 })).closest(
    'tr',
  ) as HTMLElement;
  return within(row).getAllByRole('cell')[col]!.textContent ?? '';
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

// ─── Рахунок ─────────────────────────────────────────────────────────────────

const invoiceDoc = (lines: { description: string; quantity: number; unitPrice: number }[]) => ({
  id: 'inv-1',
  number: 'РАХ-0001',
  status: 'DRAFT',
  invoiceType: 'STANDARD',
  counterpartyId: CP,
  counterpartyName: 'Клієнт',
  amount: 0,
  paidAmount: 0,
  dueDate: null,
  documentDate: '2026-10-13T00:00:00.000Z',
  notes: null,
  deletedAt: null,
  // Без `priceWithVat`: картка рахує суму рядка сама (новий ручний рядок поводиться так само).
  lines: lines.map((l, i) => ({ id: `line-${i}`, vatRate: 0, ...l })),
});

describe('Картка рахунку — сума рядка округлена до копійки (BR-INV-017, клас Bug #811)', () => {
  // guards: BR-INV-017
  it('рахунок: рядок 0,3 × 100,05 — 30.02, а не 30.01', async () => {
    mockApi(
      '/invoices/inv-1?withDeleted=true',
      invoiceDoc([{ description: 'Діагностика', quantity: 0.3, unitPrice: 100.05 }]),
    );
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    expect(await lineCell('Діагностика', 3)).toBe('30.02');
    expect(totalRow()).toHaveTextContent('30.02');
  });

  // guards: BR-INV-017
  it('рахунок: три рядки 0,3 × 111,11 — «Разом» 99.99, а не 100.00', async () => {
    mockApi(
      '/invoices/inv-1?withDeleted=true',
      invoiceDoc(
        ['А', 'Б', 'В'].map(d => ({
          description: `Робота ${d}`,
          quantity: 0.3,
          unitPrice: 111.11,
        })),
      ),
    );
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    await screen.findByText('Робота В', undefined, { timeout: 2000 });
    expect(totalRow()).toHaveTextContent('99.99');
  });

  it('рахунок: новий рядок 0,3 × 100,05 — прев’ю 30.02', async () => {
    mockApi('/invoices/inv-1?withDeleted=true', invoiceDoc([]));
    const user = userEvent.setup();
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Додати' }, { timeout: 2000 }));
    const desc = await screen.findByPlaceholderText('Опис позиції…');
    const row = desc.closest('tr') as HTMLElement;
    const qty = row.querySelector('input[min="0.001"]') as HTMLInputElement;
    await user.clear(qty);
    await user.type(qty, '0.3');
    await user.type(within(row).getByPlaceholderText('0.00'), '100.05');
    expect(within(row).getAllByRole('cell')[3]).toHaveTextContent('30.02');
  });

  it('рахунок: POST /invoices несе суму округлених рядків (три по 0,3 × 111,11 → 99.99)', async () => {
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith('/counterparties')) {
        return Promise.resolve({ items: [{ id: CP, companyName: 'ТОВ' }] });
      }
      if (path === '/invoices' && init?.method === 'POST') {
        return Promise.resolve({ id: 'inv-9', number: 'РАХ-0009' });
      }
      if (/^\/invoices\/[^/]+\/lines$/.test(path)) return Promise.resolve({});
      return Promise.resolve({ items: [] });
    });
    const user = userEvent.setup();
    render(<InvoiceCreateModal open onClose={vi.fn()} onSaved={vi.fn()} />);

    const combo = await screen.findByPlaceholderText('Пошук контрагента…', undefined, {
      timeout: 2000,
    });
    await user.type(combo, 'ТОВ');
    await user.click(await screen.findByText('ТОВ', {}, { timeout: 2000 }));

    for (const d of ['А', 'Б', 'В']) {
      await user.click(await screen.findByRole('button', { name: 'Додати' }, { timeout: 2000 }));
      const desc = await screen.findByPlaceholderText('Опис позиції…');
      const row = desc.closest('tr') as HTMLElement;
      await user.type(desc, `Робота ${d}`);
      const qty = row.querySelector('input[min="0.001"]') as HTMLInputElement;
      await user.clear(qty);
      await user.type(qty, '0.3');
      await user.type(within(row).getByPlaceholderText('0.00'), '111.11');
      await user.click(row.querySelector('button[type="button"]') as HTMLButtonElement);
      await screen.findByText(`Робота ${d}`);
    }

    const create = await screen.findByRole('button', { name: /Створити рахунок/ });
    await waitFor(() => expect(create).toBeEnabled());
    await act(async () => {
      await user.click(create);
    });

    await waitFor(() =>
      expect(
        apiFetchMock.mock.calls.some(
          ([p, init]) => p === '/invoices' && (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    );
    const [, init] = apiFetchMock.mock.calls.find(
      ([p, i]) => p === '/invoices' && (i as RequestInit | undefined)?.method === 'POST',
    )!;
    expect(JSON.parse((init as RequestInit).body as string).amount).toBe(99.99);
  }, 15_000);
});

// ─── Замовлення постачальнику ────────────────────────────────────────────────

const poDoc = (lines: { goodName: string; quantity: number; price: number }[]) => ({
  id: 'po-1',
  number: 'ЗАМ-000001',
  status: 'DRAFT',
  supplierId: 's1',
  supplierName: 'Постачальник',
  warehouseId: 'w1',
  documentDate: '2026-10-13',
  totalAmount: 0,
  deletedAt: null,
  lines: lines.map((l, i) => ({ id: `l${i}`, goodId: `g${i}`, receivedQty: 0, ...l })),
});

describe('Картка замовлення постачальнику — сума рядка округлена до копійки (BR-WO-007)', () => {
  it('замовлення: рядок 0,3 × 100,05 — 30.02', async () => {
    mockApi(
      '/purchase-orders/po-1?withDeleted=true',
      poDoc([{ goodName: 'Фільтр', quantity: 0.3, price: 100.05 }]),
    );
    renderWithQueryClient(
      <PurchaseOrderCreateModal open purchaseOrderId="po-1" onClose={vi.fn()} />,
    );
    const row = (await screen.findByText('Фільтр', undefined, { timeout: 2000 })).closest(
      'tr',
    ) as HTMLElement;
    expect(
      within(row)
        .getAllByRole('cell')
        .map(c => c.textContent),
    ).toContain('30.02');
    expect(totalRow()).toHaveTextContent('30.02');
  });

  it('замовлення: три рядки 0,3 × 111,11 — «Разом» 99.99', async () => {
    mockApi(
      '/purchase-orders/po-1?withDeleted=true',
      poDoc(['А', 'Б', 'В'].map(d => ({ goodName: `Товар ${d}`, quantity: 0.3, price: 111.11 }))),
    );
    renderWithQueryClient(
      <PurchaseOrderCreateModal open purchaseOrderId="po-1" onClose={vi.fn()} />,
    );
    await screen.findByText('Товар В', undefined, { timeout: 2000 });
    expect(totalRow()).toHaveTextContent('99.99');
  });
});

// ─── Складський документ ─────────────────────────────────────────────────────

const sdDoc = (lines: { goodName: string; quantity: number; price: number }[]) => ({
  id: 'sd-1',
  number: 'ПРХ-000001',
  status: 'DRAFT',
  type: 'RECEIPT',
  branchId: 'b1',
  warehouseId: 'w1',
  documentDate: '2026-10-13',
  deletedAt: null,
  lines: lines.map((l, i) => ({ id: `l${i}`, goodId: `g${i}`, ...l })),
});

describe('Картка складського документа — сума рядка округлена до копійки (BR-WO-007)', () => {
  it('складський документ: рядок 0,3 × 100,05 — 30.02', async () => {
    mockApi(
      '/stock-documents/sd-1?withDeleted=true',
      sdDoc([{ goodName: 'Фільтр', quantity: 0.3, price: 100.05 }]),
    );
    render(<StockDocumentCreateModal open stockDocumentId="sd-1" onClose={vi.fn()} />);
    // Колонки: товар · артикул · ОВ · к-сть · ціна · сума.
    expect(await lineCell('Фільтр', 5)).toBe('30.02');
    expect(totalRow()).toHaveTextContent('30,02');
  });

  it('складський документ: три рядки 0,3 × 111,11 — «Разом» 99,99', async () => {
    mockApi(
      '/stock-documents/sd-1?withDeleted=true',
      sdDoc(['А', 'Б', 'В'].map(d => ({ goodName: `Товар ${d}`, quantity: 0.3, price: 111.11 }))),
    );
    render(<StockDocumentCreateModal open stockDocumentId="sd-1" onClose={vi.fn()} />);
    await screen.findByText('Товар В', undefined, { timeout: 2000 });
    expect(totalRow()).toHaveTextContent('99,99');
  });

  it('складський документ: новий рядок 0,3 × 100,05 — прев’ю 30.02', async () => {
    mockApi('/stock-documents/sd-1?withDeleted=true', sdDoc([]));
    const user = userEvent.setup();
    render(<StockDocumentCreateModal open stockDocumentId="sd-1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Додати' }, { timeout: 2000 }));
    const row = (await screen.findByText('Оберіть товар…')).closest('tr') as HTMLElement;
    const qty = row.querySelector('input[min="0.001"]') as HTMLInputElement;
    await user.clear(qty);
    await user.type(qty, '0.3');
    await user.type(within(row).getByPlaceholderText('0.00'), '100.05');
    expect(within(row).getAllByRole('cell')[5]).toHaveTextContent('30.02');
  });
});
