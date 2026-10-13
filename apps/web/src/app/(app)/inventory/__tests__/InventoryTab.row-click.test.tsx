// Залишки (режим «По товарах») — стандарт кліку по рядку (рішення власника 2026-10-13).
// Картки залишку немає, тому зі стандарту тут лише панель: клік показує, повторний клік по тому
// самому рядку ховає (раніше повторний клік нічого не робив — сховати можна було лише хрестиком).

import { screen } from '@testing-library/react';
import { vi, describe, beforeEach } from 'vitest';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import { itFollowsRowClickStandard } from '../../../../__tests__/row-click-standard';

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve([])),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));

const ITEM_A = {
  id: 'si-a',
  goodId: 'g-a',
  goodName: 'Фільтр масляний',
  goodSku: 'F-1',
  warehouseId: 'w-1',
  warehouseName: 'Основний склад',
  quantity: 5,
  reserved: 0,
  available: 5,
  minStock: null,
  isLow: false,
  unit: 'шт',
  purchasePrice: 100,
  salePrice: 150,
};
const ITEM_B = { ...ITEM_A, id: 'si-b', goodId: 'g-b', goodName: 'Фільтр повітряний' };
// Один і той самий масив між рендерами — як його віддає TanStack Query.
const ITEMS = [ITEM_A, ITEM_B];

vi.mock('@/hooks/api/useInventory', () => ({
  inventoryKeys: { all: ['inventory'], items: () => ['inventory', 'items'] },
  useStockItems: () => ({ data: ITEMS, isLoading: false, error: null, refetch: vi.fn() }),
  useLowStockItems: () => ({ data: [], refetch: vi.fn() }),
  useStockByDocument: () => ({ data: { goods: [] }, isLoading: false }),
  useStockByBatch: () => ({ data: { batches: [] }, isLoading: false }),
}));

import { InventoryTab } from '../InventoryTab';

describe('Залишки (по товарах) — стандарт кліку по рядку', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  itFollowsRowClickStandard({
    renderPage: () => {
      renderWithQueryClient(<InventoryTab />);
    },
    panelKey: 'inventory',
    rowText: 'Фільтр масляний',
    panelTitle: 'Фільтр масляний',
    pencil: () => screen.getByRole('table'),
    panelButton: null,
    isCardOpen: null,
  });
});
