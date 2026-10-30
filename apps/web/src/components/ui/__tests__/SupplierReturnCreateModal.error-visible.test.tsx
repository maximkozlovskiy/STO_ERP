// Bug #1017 (клас Bug #1014 рахунку): «Додати» згортає шапку повернення постачальнику (0fr +
// overflow-hidden), а смуга помилки жила в шапці — відмова «Зберегти зміни» була невидима, картка
// мовчки лишалась відкритою. Помилка — над шапкою (`DocumentCardBody`), `role="alert"`.
//
// Мутація (перевірено): повернути `{error && …}` усередину `CollapsibleDocumentHeader` → тест падає.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { SupplierReturnCreateModal } from '../SupplierReturnCreateModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/hooks/useUiFeatures', () => ({ useUiFeatures: () => ({ toastEnabled: false }) }));

const RETURN = {
  id: 'sr1',
  number: 'ПОВ-1',
  status: 'DRAFT',
  supplierId: '11111111-1111-4111-8111-111111111111',
  supplierName: 'ТОВ Постач',
  warehouseId: '22222222-2222-4222-8222-222222222222',
  notes: '',
  documentDate: '2026-09-05',
  lines: [
    {
      id: 'l1',
      goodId: '33333333-3333-4333-8333-333333333333',
      goodName: 'Фільтр',
      goodSku: 'F-1',
      unit: 'шт',
      unitShortName: 'шт',
      unitOfMeasureId: '55555555-5555-4555-8555-555555555555',
      quantity: 2,
      price: 100,
    },
  ],
};

describe('Картка повернення постачальнику — помилка видима при згорнутій шапці (Bug #1017)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/supplier-returns/sr1' && init?.method === 'PATCH') {
        return Promise.reject(new Error('Збій мережі'));
      }
      if (path === '/warehouses')
        return Promise.resolve([{ id: '22222222-2222-4222-8222-222222222222', name: 'Склад №1' }]);
      if (path === '/supplier-returns/sr1?withDeleted=true') return Promise.resolve(RETURN);
      return Promise.resolve({ items: [] });
    });
  });

  it('«Додати» згорнуло шапку, відмова збереження — над шапкою з role="alert"', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SupplierReturnCreateModal open onClose={onClose} onSaved={vi.fn()} editId="sr1" />);
    await screen.findByRole('button', { name: 'Підтвердити' });

    await user.click(screen.getByRole('button', { name: 'Додати' }));
    const header = screen.getByTestId('document-card-header');
    expect(header).toHaveAttribute('data-collapsed', 'true');

    await user.click(screen.getByRole('button', { name: 'Зберегти зміни' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Збій мережі');
    expect(alert).toHaveAttribute('data-testid', 'supplier-return-card-error');
    expect(header.contains(alert)).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });
});
