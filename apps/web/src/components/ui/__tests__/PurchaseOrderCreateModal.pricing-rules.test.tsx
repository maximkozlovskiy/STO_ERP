// Розцінка закупівлі (BR-PO-006, блок 4 №17, №18).
//
// Що стережуть ці тести:
//  - «За правилом» показує лише правила, що можуть розцінити це замовлення: активні й без
//    постачальника або з постачальником замовлення; вимкнених і чужих немає, перемикача «Всі
//    правила» немає (№18);
//  - «Розцінити» без правила: тост називає, скільки рядків лишились без правила (№17).
//
// Mutation-verify (2026-11-14): прибрати `r.isActive` у `applicablePricingRules` → кейс №18 падає
// на «Вимкнене»; `r.supplierId === supplierId` → `true` → падає на «Чужий постачальник»; тост лише
// з `toast.pricedGoods` → кейс №17 падає.

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { PurchaseOrderCreateModal } from '../PurchaseOrderCreateModal';
import { applicablePricingRules } from '../purchase-order/RulePricerModal';
import { renderWithQueryClient } from '../../../__tests__/query-utils';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiPost: (path: string, body?: unknown) =>
    apiFetchMock(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
}));
const toastSuccess = vi.fn();
vi.mock('@/lib/toast', () => ({
  toast: { success: (m: string) => toastSuccess(m), error: vi.fn(), info: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { role: 'OWNER' } }) }));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));
vi.mock('@/components/ui/xlsx-import-button', () => ({ XlsxImportButton: () => null }));
vi.mock('@/components/ui/ExcelImportWizard', () => ({ ExcelImportWizard: () => null }));

const PO = {
  id: 'po-1',
  number: 'ЗАМ-000017',
  status: 'RECEIVED',
  supplierId: 'sup-own',
  supplierName: 'Свій постачальник',
  warehouseId: 'w1',
  documentDate: '2026-11-14',
  totalAmount: 400,
  deletedAt: null,
  lines: [{ id: 'l1', goodId: 'g1', goodName: 'Фільтр', quantity: 8, price: 50, receivedQty: 8 }],
};

const RULES = [
  { id: 'r-all', name: 'Загальне +30%', description: null, isActive: true, supplierId: null },
  { id: 'r-own', name: 'Свій +20%', description: null, isActive: true, supplierId: 'sup-own' },
  {
    id: 'r-alien',
    name: 'Чужий постачальник',
    description: null,
    isActive: true,
    supplierId: 'sup-x',
  },
  { id: 'r-off', name: 'Вимкнене', description: null, isActive: false, supplierId: null },
  {
    id: 'r-own-off',
    name: 'Свій вимкнений',
    description: null,
    isActive: false,
    supplierId: 'sup-own',
  },
];

beforeEach(() => {
  apiFetchMock.mockReset();
  toastSuccess.mockReset();
  apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/purchase-orders/po-1/apply-pricing' && init?.method === 'POST')
      return Promise.resolve({ updated: 3, noRule: 2, details: [] });
    if (path.startsWith('/purchase-orders/po-1')) return Promise.resolve(PO);
    if (path === '/pricing-rules') return Promise.resolve({ items: RULES, total: RULES.length });
    if (path === '/warehouses')
      return Promise.resolve([{ id: 'w1', name: 'Склад', deletedAt: null }]);
    if (path === '/settings/organisation')
      return Promise.resolve({ vatMode: 'NONE', defaultVatRateId: null });
    if (path === '/settings/tax-rates') return Promise.resolve([]);
    return Promise.resolve({ items: [] });
  });
});

const openCard = async () => {
  renderWithQueryClient(
    <PurchaseOrderCreateModal open purchaseOrderId="po-1" onClose={vi.fn()} onSaved={vi.fn()} />,
  );
  await waitFor(() => expect(screen.getAllByText('Фільтр').length).toBeGreaterThan(0));
};

// guards: BR-PO-006
describe('«Розцінити правилом» — лише правила, що можуть розцінити замовлення (№18)', () => {
  it('активні без постачальника й свого постачальника; вимкнених і чужих немає, перемикача теж', async () => {
    const user = userEvent.setup();
    await openCard();

    await user.click(screen.getByRole('button', { name: 'За правилом' }));

    expect(await screen.findByRole('button', { name: 'Загальне +30%' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Свій +20%' })).toBeInTheDocument();
    for (const hidden of ['Чужий постачальник', 'Вимкнене', 'Свій вимкнений', 'Всі правила'])
      expect(screen.queryByRole('button', { name: hidden })).not.toBeInTheDocument();
    // Один запит усіх правил — відбір на клієнті (без `?supplierId=`, який сховав би загальні).
    expect(apiFetchMock).toHaveBeenCalledWith('/pricing-rules');
  });

  it('applicablePricingRules: без постачальника замовлення — лише активні загальні', () => {
    expect(applicablePricingRules(RULES, null).map(r => r.id)).toEqual(['r-all']);
    expect(applicablePricingRules(RULES, 'sup-own').map(r => r.id)).toEqual(['r-all', 'r-own']);
  });
});

// guards: BR-PO-006
describe('«Розцінити» без правила — звіт «без правила» (№17)', () => {
  it('тост називає, скільки товарів лишились без правила й без зміни ціни', async () => {
    const user = userEvent.setup();
    await openCard();

    await user.click(screen.getByRole('button', { name: 'Розцінити' }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        'Розцінено 3 товарів; без правила — 2 (ціну не змінено)',
      ),
    );
  });
});
