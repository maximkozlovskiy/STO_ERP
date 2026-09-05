// Regression-guard для unsaved-guard baseline у document-модалках (Ф5, Bug #639).
//
// Bug guarded (audit 2026-09-05, Bug #639 — dirty-guard false positive):
//   Модалки озброюють dirty-базлайн через setTimeout(0). Але /warehouses і /branches
//   вантажаться АСИНХРОННО, і авто-вибір єдиного складу/філії осідає ПІЗНІШЕ за цей
//   таймер → програмна установка warehouseId/branchId хибно позначала чисту форму
//   брудною. Наслідок: користувач відкриває модалку, нічого не чіпає, тисне Escape →
//   спливає діалог «Є незбережені зміни». Фікс: autoWarehouseRef/autoBranchRef/
//   autoDefaultsRef — dirty-детектор пропускає рівно ці програмні авто-вибори.
//
// Дискримінація доведена ручним revert-ом skip-блоку (→ діалог спливає на чистій формі).

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
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

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: vi.fn(),
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({
    toastEnabled: false,
    unsavedGuardEnabled: true,
    keyboardShortcutsEnabled: false,
  }),
}));

// InvoiceCreateModal reads the TabBar context (minimize-to-tab). Provide a stub so
// the modal mounts standalone in jsdom.
vi.mock('@/contexts/TabBarContext', () => ({
  useTabBarContext: () => ({ minimizeModal: vi.fn() }),
}));

vi.mock('@/lib/format', async () => ({
  ...(await vi.importActual<typeof import('@/lib/format')>('@/lib/format')),
  kyivToday: () => '2026-09-05',
}));

// Рівно ОДИН склад/філія → спрацьовує async авто-вибір (джерело false-positive).
const oneWarehouse = [{ id: 'w1', name: 'Склад №1', deletedAt: null }];
const oneBranch = [{ id: 'b1', name: 'Філія №1' }];

describe('PurchaseOrderCreateModal — unsaved-guard baseline (Ф5, Bug #639)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/warehouses') return Promise.resolve(oneWarehouse);
      if (path.startsWith('/settings') || path.includes('vat') || path.includes('tax'))
        return Promise.resolve({ items: [] });
      return Promise.resolve({ items: [] });
    });
  });

  it('авто-вибір єдиного складу НЕ робить чисту форму брудною → Escape закриває без діалогу', async () => {
    const onClose = vi.fn();
    renderWithQueryClient(<PurchaseOrderCreateModal open onClose={onClose} onSaved={() => {}} />);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/warehouses'));
    // Дати авто-вибору осісти (async load → auto-select → re-render).
    await act(async () => {
      await new Promise(r => setTimeout(r, 60));
    });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Є незбережені зміни')).not.toBeInTheDocument();
  });
});

describe('InvoiceCreateModal — unsaved-guard baseline (Ф5, value-based)', () => {
  // Регресія до value-based dirty-детекції (E2E invoices.spec.ts:127 «модалка не
  // закривається по Escape»). InvoiceCreateModal НЕ має авто-вибору, тож старий
  // autoDefaultsRef-скіп його не покривав — і все одно чиста форма позначалась
  // брудною: ре-рендер (async useUiFeatures/useTabBar) давав `form` новий reference
  // ПІСЛЯ setTimeout(0)-базлайну → markDirty → хибний діалог «Є незбережені зміни».
  // Value-based порівняння знімків усуває цей клас: reference-only churn не dirty.
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path.startsWith('/counterparties')) return Promise.resolve({ items: [] });
      return Promise.resolve({ items: [] });
    });
  });

  it('чиста форма (нічого не введено) → Escape закриває без діалогу «Є незбережені зміни»', async () => {
    const onClose = vi.fn();
    renderWithQueryClient(<InvoiceCreateModal open onClose={onClose} onSaved={() => {}} />);

    await waitFor(() => expect(screen.getByText('Новий рахунок')).toBeInTheDocument());
    // Дати всім async-ре-рендерам (features/context/reset) осісти.
    await act(async () => {
      await new Promise(r => setTimeout(r, 60));
    });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Є незбережені зміни')).not.toBeInTheDocument();
  });
});

describe('StockDocumentCreateModal — unsaved-guard baseline (Ф5, Bug #639)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/branches') return Promise.resolve(oneBranch);
      if (path === '/warehouses') return Promise.resolve(oneWarehouse);
      return Promise.resolve({ items: [] });
    });
  });

  it('авто-вибір єдиної філії+складу НЕ робить чисту форму брудною → Escape закриває без діалогу', async () => {
    const onClose = vi.fn();
    render(<StockDocumentCreateModal open onClose={onClose} onSaved={() => {}} />);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/branches'));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/warehouses'));
    await act(async () => {
      await new Promise(r => setTimeout(r, 60));
    });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Є незбережені зміни')).not.toBeInTheDocument();
  });
});
