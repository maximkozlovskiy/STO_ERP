// Regression-guard для SupplierReturnCreateModal.
//
// Bug guarded (audit 2026-09-05, family Bug #630 / WEB-H3):
//   Модалка НЕ мала синхронного savingRef/transitioningRef — на відміну від
//   Invoice/PO/Stock/WorkOrder. `disabled={saving}` спирається на re-render React
//   МІЖ подіями кліку; два click-и в одному tick обидва входять до застосування
//   disabled → 2 POST /supplier-returns або подвійний confirm. Тепер ref фліпається
//   синхронно у setSavingBoth/setTransitioningBoth → другий вхід одразу повертається.

import { render, screen, waitFor, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { SupplierReturnCreateModal } from '../SupplierReturnCreateModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: vi.fn(),
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false }),
}));

vi.mock('@/lib/format', async () => ({
  ...(await vi.importActual<typeof import('@/lib/format')>('@/lib/format')),
  kyivToday: () => '2026-09-05',
}));

const mockWarehouses = [{ id: 'w1', name: 'Склад №1' }];
const mockReturn = {
  id: 'sr1',
  number: 'ПОВ-1',
  status: 'DRAFT',
  supplierId: 'sup1',
  supplierName: 'ТОВ Постач',
  warehouseId: 'w1',
  notes: '',
  documentDate: '2026-09-05',
  lines: [
    {
      id: 'l1',
      goodId: 'g1',
      goodName: 'Фільтр',
      goodSku: 'F-1',
      unit: 'шт',
      unitShortName: 'шт',
      unitOfMeasureId: 'u1',
      quantity: 2,
      price: 100,
    },
  ],
};

describe('SupplierReturnCreateModal — double-submit guard (Bug #630 / WEB-H3)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('подвійний клік «Підтвердити» шле POST /confirm лише один раз', async () => {
    let resolveConfirm: (v: unknown) => void = () => {};
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/warehouses') return Promise.resolve(mockWarehouses);
      if (path === '/supplier-returns/sr1' && (!init || init.method === undefined)) {
        return Promise.resolve(mockReturn);
      }
      if (path === '/supplier-returns/sr1/confirm' && init?.method === 'POST') {
        return new Promise(resolve => {
          resolveConfirm = resolve;
        });
      }
      return Promise.resolve({ items: [] });
    });

    render(<SupplierReturnCreateModal open onClose={() => {}} onSaved={() => {}} editId="sr1" />);

    // Дочекатись завантаження документа (кнопка «Підтвердити» зʼявляється лише коли lines>0).
    const confirmBtn = (await screen.findByRole('button', {
      name: 'Підтвердити',
    })) as HTMLButtonElement;

    // Два синхронних native-кліки в ОДНОМУ tick через HTMLElement.click().
    // ⚠️ НЕ userEvent.click: userEvent проганяє власну pointer-event чергу з мікротасками
    // → React встигає re-renderнути й виставити disabled={transitioning} МІЖ кліками →
    // тест був би хибно-зеленим (проходив би і БЕЗ savingRef-guard). Native .click() ×2 у
    // одному синхронному блоці: React batch-ить state → re-render лише ПІСЛЯ обох → саме
    // transitioningRef (синхронний) блокує другий вхід у doTransition. Відтворює реальну race.
    confirmBtn.click();
    confirmBtn.click();

    // Дати мікротаскам відпрацювати.
    await waitFor(() => {
      const confirmCalls = apiFetchMock.mock.calls.filter(
        c => c[0] === '/supplier-returns/sr1/confirm',
      );
      expect(confirmCalls.length).toBe(1);
    });

    await act(async () => {
      resolveConfirm({});
    });
  });
});
