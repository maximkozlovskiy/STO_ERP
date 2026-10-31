// Bug #887: після «Підтвердити прийом» картка замовлення перечитувала лише статус, а рядки
// лишалися з `receivedQty` до прийому — «Частково», а «Отримано 0». Другий захід приймання з тієї
// ж картки рахував «До отримання» й «Оприбуткувати все» від застарілого значення → 400.
//
//   - після прийому 3 з 8 рядок показує «Отримано 3»;
//   - «Оприбуткувати все» на другому заході пропонує решту (5), а не всю кількість.
//
// Мутація: повернути в handleReceive перечитування лише статусу → обидві перевірки падають.

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { PurchaseOrderCreateModal } from '../PurchaseOrderCreateModal';
import { renderWithQueryClient } from '../../../__tests__/query-utils';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  // apiPost — як справжня обгортка над apiFetch: тіло JSON-ом, заголовки (Idempotency-Key) видно.
  apiPost: (path: string, body?: unknown, headers?: Record<string, string>) =>
    apiFetchMock(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(headers ? { headers } : {}),
    }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role: 'OWNER' } }),
}));

vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));
vi.mock('@/components/ui/xlsx-import-button', () => ({ XlsxImportButton: () => null }));
vi.mock('@/components/ui/ExcelImportWizard', () => ({ ExcelImportWizard: () => null }));

const po = (status: string, receivedQty: number) => ({
  id: 'po-1',
  number: 'ЗАМ-000001',
  status,
  supplierId: 's1',
  supplierName: 'Постачальник',
  warehouseId: 'w1',
  documentDate: '2026-10-13',
  totalAmount: 400,
  deletedAt: null,
  lines: [{ id: 'l1', goodId: 'g1', goodName: 'Фільтр', quantity: 8, price: 50, receivedQty }],
});

describe('PurchaseOrderCreateModal — рядки після прийому (Bug #887)', () => {
  let received = 0;

  beforeEach(() => {
    received = 0;
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
      if (path === '/purchase-orders/po-1/receive' && init?.method === 'POST') {
        const body = JSON.parse(init.body ?? '{}') as { lines: Array<{ receivedQty: number }> };
        received += body.lines[0]!.receivedQty;
        return Promise.resolve({});
      }
      if (path.startsWith('/purchase-orders/po-1')) {
        return Promise.resolve(po(received > 0 ? 'PARTIAL' : 'ORDERED', received));
      }
      if (path === '/warehouses') {
        return Promise.resolve([{ id: 'w1', name: 'Склад №1', deletedAt: null }]);
      }
      if (path === '/settings/organisation') {
        return Promise.resolve({ vatMode: 'NONE', defaultVatRateId: null });
      }
      if (path === '/settings/tax-rates') return Promise.resolve([]);
      return Promise.resolve({ items: [] });
    });
  });

  it('прийом 3 з 8: рядок показує «Отримано 3», другий захід пропонує решту 5', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <PurchaseOrderCreateModal open purchaseOrderId="po-1" onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getAllByText('Фільтр').length).toBeGreaterThan(0));

    await user.click(screen.getByRole('button', { name: 'Оприбуткувати' }));
    const row = () => screen.getAllByText('Фільтр')[0]!.closest('tr') as HTMLElement;
    const receiveInput = () => within(row()).getByPlaceholderText(/^макс\./);
    await user.type(receiveInput(), '3');
    await user.click(screen.getByRole('button', { name: 'Підтвердити прийом' }));

    await waitFor(() => expect(received).toBe(3));
    await waitFor(() => expect(within(row()).getAllByRole('cell')[3]).toHaveTextContent(/^3$/));

    await user.click(screen.getByRole('button', { name: 'Оприбуткувати' }));
    await user.click(screen.getByRole('button', { name: 'Оприбуткувати все' }));
    await waitFor(() => expect(receiveInput()).toHaveValue(5));
  });

  // BR-PO-014 (рішення власника 2026-10-30, №5): прийом іде з ключем — повтор того самого прийому
  // віддає збережену відповідь; справжній другий прийом (нове «Оприбуткувати») — новий ключ.
  // guards: BR-PO-014
  it('кожен прийом — з Idempotency-Key; другий захід — новий ключ', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <PurchaseOrderCreateModal open purchaseOrderId="po-1" onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getAllByText('Фільтр').length).toBeGreaterThan(0));
    const row = () => screen.getAllByText('Фільтр')[0]!.closest('tr') as HTMLElement;
    const receiveOnce = async (qty: string) => {
      await user.click(screen.getByRole('button', { name: 'Оприбуткувати' }));
      await user.type(within(row()).getByPlaceholderText(/^макс\./), qty);
      await user.click(screen.getByRole('button', { name: 'Підтвердити прийом' }));
    };

    await receiveOnce('1');
    await waitFor(() => expect(received).toBe(1));
    await receiveOnce('2');
    await waitFor(() => expect(received).toBe(3));

    const keys = (
      apiFetchMock.mock.calls as Array<[string, { headers?: Record<string, string> } | undefined]>
    )
      .filter(c => c[0] === '/purchase-orders/po-1/receive')
      .map(c => c[1]?.headers?.['Idempotency-Key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).not.toBe(keys[0]);
  });
});
