// Bug #851: «Оплатити» в картці замовлення постачальнику бачив і комірник, якому оплата
// заборонена (POST /supplier-payments — власник, адміністратор, бухгалтер). Клік відкривав
// порожню картку оплати й давав чотири 403.
//
//   - власник і адміністратор бачать «Оплатити»;
//   - комірник — ні, решта дій картки (збереження) на місці.
//
// Мутація: прибрати `&& canPaySupplier` біля кнопки → кейс комірника падає.
//
// BR-SUPPAY-015 (рішення власника 2026-10-30, №38): «Оплатити» — лише на замовленні «Замовлено» /
// «Частково» / «Отримано»; на чернетці й скасованому кнопки немає.
// BR-PO-015 (№41): бухгалтер бачить картку лише на перегляд — без «Зберегти», прийому й переходів,
// але «Оплатити» лишається.

import { screen, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { PurchaseOrderCreateModal } from '../PurchaseOrderCreateModal';
import { renderWithQueryClient } from '../../../__tests__/query-utils';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiPost: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

const auth = vi.hoisted(() => ({ role: 'OWNER' }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role: auth.role } }),
}));

vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));
vi.mock('@/components/ui/xlsx-import-button', () => ({ XlsxImportButton: () => null }));
vi.mock('@/components/ui/ExcelImportWizard', () => ({ ExcelImportWizard: () => null }));

const PO = {
  id: 'po-1',
  number: 'ЗАМ-000001',
  status: 'DRAFT',
  supplierId: 's1',
  supplierName: 'Постачальник',
  warehouseId: 'w1',
  documentDate: '2026-10-13',
  totalAmount: 10,
  deletedAt: null,
  lines: [{ id: 'l1', goodId: 'g1', goodName: 'Фільтр', quantity: 1, price: 10, receivedQty: 0 }],
};

async function renderCard(role: string, status = 'DRAFT') {
  auth.role = role;
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/purchase-orders/po-1?withDeleted=true')
      return Promise.resolve({ ...PO, status });
    if (path === '/warehouses') {
      return Promise.resolve([{ id: 'w1', name: 'Склад №1', deletedAt: null }]);
    }
    if (path === '/settings/organisation') {
      return Promise.resolve({ vatMode: 'NONE', defaultVatRateId: null });
    }
    if (path === '/settings/tax-rates') return Promise.resolve([]);
    return Promise.resolve({ items: [] });
  });
  renderWithQueryClient(<PurchaseOrderCreateModal open purchaseOrderId="po-1" onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getAllByText('Фільтр').length).toBeGreaterThan(0));
}

describe('PurchaseOrderCreateModal — «Оплатити» за роллю (Bug #851)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it.each(['OWNER', 'ADMIN', 'ACCOUNTANT'])(
    '%s бачить «Оплатити» на замовленні «Замовлено»',
    async role => {
      await renderCard(role, 'ORDERED');
      expect(screen.getByRole('button', { name: /Оплатити/ })).toBeInTheDocument();
    },
  );

  // guards: BR-SUPPAY-015
  it.each([
    ['ORDERED', true],
    ['PARTIAL', true],
    ['RECEIVED', true],
    ['DRAFT', false],
    ['CANCELLED', false],
  ])('замовлення %s → «Оплатити» видно: %s', async (status, shown) => {
    await renderCard('OWNER', status);
    const btn = screen.queryByRole('button', { name: /Оплатити/ });
    if (shown) expect(btn).toBeInTheDocument();
    else expect(btn).not.toBeInTheDocument();
  });

  // guards: BR-PO-015
  it('бухгалтер: картка лише на перегляд — без «Зберегти» й «Оприбуткувати», «Оплатити» на місці', async () => {
    await renderCard('ACCOUNTANT', 'ORDERED');
    expect(screen.getByRole('button', { name: /Оплатити/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Оприбуткувати' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Зберегти зміни' })).not.toBeInTheDocument();
  });

  // guards: BR-PO-015
  it('бухгалтер на чернетці: поля шапки заблоковані, «Зберегти» немає', async () => {
    await renderCard('ACCOUNTANT', 'DRAFT');
    expect(screen.queryByRole('button', { name: 'Зберегти зміни' })).not.toBeInTheDocument();
    for (const input of screen.getAllByPlaceholderText('ДД.ММ.РРРР')) {
      expect(input).toBeDisabled();
    }
  });

  // Контроль до кейсу бухгалтера: комірник на «Замовлено» приймає товар.
  // guards: BR-PO-015
  it('комірник на «Замовлено» бачить «Оприбуткувати»', async () => {
    await renderCard('STOREKEEPER', 'ORDERED');
    expect(screen.getByRole('button', { name: 'Оприбуткувати' })).toBeInTheDocument();
  });

  it('комірник «Оплатити» не бачить, картка лишається робочою', async () => {
    await renderCard('STOREKEEPER');
    expect(screen.queryByRole('button', { name: /Оплатити/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Зберегти зміни' })).toBeInTheDocument();
  });
});
