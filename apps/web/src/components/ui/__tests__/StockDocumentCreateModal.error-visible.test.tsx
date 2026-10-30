// Bug #1017 (клас Bug #1014 рахунку): «Додати» згортає шапку складського документа (0fr +
// overflow-hidden), а смуга помилки жила в шапці — відмова «Зберегти зміни» була невидима, картка
// мовчки лишалась відкритою. Помилка — над шапкою (`DocumentCardBody`), `role="alert"`.
//
// Мутація (перевірено): повернути `{error && …}` усередину `CollapsibleDocumentHeader` → тест падає.

import { render, screen, waitFor } from '@testing-library/react';
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

const DOC = {
  id: 'sd-1',
  number: 'ПРХ-000001',
  status: 'DRAFT',
  type: 'RECEIPT',
  branchId: '44444444-4444-4444-8444-444444444444',
  warehouseId: '22222222-2222-4222-8222-222222222222',
  documentDate: '2026-10-13',
  confirmedAt: null,
  deletedAt: null,
  lines: [
    {
      id: 'l1',
      goodId: '33333333-3333-4333-8333-333333333333',
      goodName: 'Фільтр оливний',
      unit: 'шт',
      quantity: 1,
      price: 10,
    },
  ],
};

describe('Картка складського документа — помилка видима при згорнутій шапці (Bug #1017)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/stock-documents/sd-1' && init?.method === 'PATCH') {
        return Promise.reject(new Error('Збій мережі'));
      }
      if (path === '/branches')
        return Promise.resolve([{ id: '44444444-4444-4444-8444-444444444444', name: 'Філія №1' }]);
      if (path === '/warehouses') {
        return Promise.resolve([
          { id: '22222222-2222-4222-8222-222222222222', name: 'Склад №1', deletedAt: null },
        ]);
      }
      if (path === '/stock-documents/sd-1?withDeleted=true') return Promise.resolve(DOC);
      return Promise.resolve({ items: [] });
    });
  });

  it('«Додати» згорнуло шапку, відмова збереження — над шапкою з role="alert"', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<StockDocumentCreateModal open stockDocumentId="sd-1" onClose={onClose} />);
    await screen.findByText('Фільтр оливний', undefined, { timeout: 2000 });

    await user.click(screen.getByRole('button', { name: 'Додати' }));
    const header = screen.getByTestId('document-card-header');
    expect(header).toHaveAttribute('data-collapsed', 'true');

    await user.click(screen.getByRole('button', { name: 'Зберегти зміни' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Збій мережі');
    expect(alert).toHaveAttribute('data-testid', 'stock-document-card-error');
    expect(header.contains(alert)).toBe(false);
    await waitFor(() => expect(onClose).not.toHaveBeenCalled());
  });
});
