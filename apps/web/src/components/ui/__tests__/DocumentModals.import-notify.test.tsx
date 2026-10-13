// Bug #838: імпорт рядків з XLSX у картці складського документа / замовлення постачальнику пише
// рядки в базу одразу, без «Зберегти». Картка перечитувала документ, але сторінку не сповіщала:
// після закриття хрестиком список і «Зведення» бокової панелі показували числа до імпорту
// (наживо 2026-10-13: у базі 4 рядки / 9,8 од., у панелі — 3 рядки / 1,3 од.).
//
// Кнопка імпорту й майстер замінені заглушками: тут перевіряється лише те, що картка робить,
// коли імпорт завершився.
//
// Mutation-verify (2026-10-13): прибрати `onSaved?.()` з handleLinesImported у будь-якій із двох
// карток → падає відповідний кейс «сповіщає сторінку».

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';

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

// Заглушка кнопки імпорту: клік = «сервер прийняв файл і записав рядки».
vi.mock('@/components/ui/xlsx-import-button', () => ({
  XlsxImportButton: ({ onImportComplete }: { onImportComplete?: (r: unknown) => void }) => (
    <button type="button" onClick={() => onImportComplete?.({ created: 1, updated: 1 })}>
      тест-імпорт-xlsx
    </button>
  ),
}));
vi.mock('@/components/ui/ExcelImportWizard', () => ({
  ExcelImportWizard: () => null,
}));

const DOC = '20000000-0000-4000-8000-000000000001';
const PO = '20000000-0000-4000-8000-000000000002';

const docLoads = (path: string) => apiFetchMock.mock.calls.filter(([p]) => p === path).length;

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('StockDocumentCreateModal — імпорт рядків з XLSX', () => {
  beforeEach(() => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/branches') return Promise.resolve([{ id: 'b1', name: 'Філія №1' }]);
      if (path === '/warehouses') {
        return Promise.resolve([{ id: 'w1', name: 'Склад №1', deletedAt: null }]);
      }
      if (path === `/stock-documents/${DOC}`) {
        return Promise.resolve({
          id: DOC,
          number: 'ПРХ-000001',
          status: 'DRAFT',
          type: 'RECEIPT',
          branchId: 'b1',
          warehouseId: 'w1',
          documentDate: '2026-10-13',
          lines: [{ id: 'l1', goodId: 'g1', goodName: 'Фільтр', quantity: 1, price: 10 }],
        });
      }
      return Promise.resolve({ items: [] });
    });
  });

  it('після імпорту перечитує документ і сповіщає сторінку (onSaved), картку не закриває', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      <StockDocumentCreateModal open stockDocumentId={DOC} onClose={onClose} onSaved={onSaved} />,
    );
    await screen.findByText('Фільтр');
    expect(docLoads(`/stock-documents/${DOC}`)).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: 'тест-імпорт-xlsx' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(docLoads(`/stock-documents/${DOC}`)).toBe(2));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('PurchaseOrderCreateModal — імпорт рядків з XLSX', () => {
  beforeEach(() => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/warehouses') {
        return Promise.resolve([{ id: 'w1', name: 'Склад №1', deletedAt: null }]);
      }
      if (path === `/purchase-orders/${PO}`) {
        return Promise.resolve({
          id: PO,
          number: 'ЗАМ-000001',
          status: 'DRAFT',
          supplierId: 's1',
          supplierName: 'Постачальник',
          warehouseId: 'w1',
          documentDate: '2026-10-13',
          totalAmount: 10,
          lines: [
            { id: 'l1', goodId: 'g1', goodName: 'Фільтр', quantity: 1, price: 10, receivedQty: 0 },
          ],
        });
      }
      return Promise.resolve({ items: [] });
    });
  });

  it('у картці наявного замовлення: перечитує його і сповіщає сторінку (onSaved)', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    renderWithQueryClient(
      <PurchaseOrderCreateModal open purchaseOrderId={PO} onClose={onClose} onSaved={onSaved} />,
    );
    await screen.findByText('Фільтр');
    const before = docLoads(`/purchase-orders/${PO}`);

    await userEvent.click(await screen.findByRole('button', { name: 'тест-імпорт-xlsx' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(docLoads(`/purchase-orders/${PO}`)).toBe(before + 1));
    expect(onClose).not.toHaveBeenCalled();
  });
});
