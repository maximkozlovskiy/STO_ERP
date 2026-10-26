// Залишки: кількість показується через спільний `fmtQty`, а не як є (TECH-DEBT §8 L692).
// Залишки зберігаються як Float, тож після кількох рухів у числі лишається хвіст на кшталт
// `34.367000000000004` — таблиця, бейдж мінімуму й панель показували його сирим.

import { screen, fireEvent, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { renderWithQueryClient } from '@/__tests__/query-utils';

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve([])),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));

const ITEM = {
  id: 'si-a',
  goodId: 'g-a',
  goodName: 'Мастило моторне',
  goodSku: 'M-1',
  warehouseId: 'w-1',
  warehouseName: 'Основний склад',
  quantity: 34.367000000000004,
  reserved: 0.30000000000000004,
  available: 34.067000000000004,
  minStock: 2.5,
  isLow: false,
  unit: 'л',
  purchasePrice: 100,
  salePrice: 150,
};
const ITEMS = [ITEM];

vi.mock('@/hooks/api/useInventory', () => ({
  inventoryKeys: { all: ['inventory'], items: () => ['inventory', 'items'] },
  useStockItems: () => ({ data: ITEMS, isLoading: false, error: null, refetch: vi.fn() }),
  useLowStockItems: () => ({ data: [], refetch: vi.fn() }),
  useStockByDocument: () => ({ data: { goods: [] }, isLoading: false }),
  useStockByBatch: () => ({ data: { batches: [] }, isLoading: false }),
}));

import { InventoryTab } from '../InventoryTab';

describe('Залишки — формат кількості', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('таблиця й панель показують 34,367, а не хвіст float-арифметики', () => {
    renderWithQueryClient(<InventoryTab />);
    const row = within(screen.getByText('Мастило моторне').closest('tr')!);

    expect(row.getByText('34,367 л')).toBeInTheDocument();
    expect(row.getByText('0,3')).toBeInTheDocument();
    expect(row.getByText('34,067 л')).toBeInTheDocument();
    expect(row.getByText('≥ 2,5 л')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Мастило моторне'));
    expect(screen.getAllByText('34,367 л').length).toBeGreaterThan(1);
    expect(document.body.textContent).not.toMatch(/0000000000/);
  });
});
