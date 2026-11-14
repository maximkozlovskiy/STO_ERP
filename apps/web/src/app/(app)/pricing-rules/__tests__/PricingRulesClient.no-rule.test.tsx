// Розцінка без правила не змінює ціну — звіти сторінки правил (BR-GOOD-011, блок 4 №17).
//
// Що стережуть ці тести:
//  - «Розцінити список»: лічильник «Без правила» і рядок товару з позначкою «без правила» замість
//    нової ціни (ціна та сама — сервер її не змінював);
//  - «Перерахувати» правило: тост називає, скільки товарів лишилось без правила.
//
// Mutation-verify (2026-11-14): прибрати гілку `d.noRule ? …` у комірці «Нова» → кейс про рядок
// «без правила» падає; тост лише з `applyResult.done` → кейс про «Перерахувати» падає.

import { screen, fireEvent, within, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import type { PricingRule } from '../types';

const apiFetchMock = vi.fn();
const apiMultipartFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
  apiMultipartFetch: (...a: unknown[]) => apiMultipartFetchMock(...a),
}));
const toastSuccess = vi.fn();
vi.mock('@/lib/toast', () => ({
  toast: { success: (m: string) => toastSuccess(m), error: vi.fn() },
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role: 'OWNER' } }),
  useRequireAuth: () => undefined,
}));

import PricingRulesClient from '../PricingRulesClient';

const RULE: PricingRule = {
  id: 'r-sup',
  name: 'Постачальник +60%',
  type: 'PERCENT',
  priority: 10,
  goodsCount: 0,
  hasGoodsList: false,
  goodsPreview: [],
  goodCategoryId: null,
  goodCategoryName: null,
  goodCategory: null,
  goodType: null,
  brandId: null,
  brandName: null,
  supplierId: 'sup-1',
  supplierName: 'Постачальник',
  percentValue: 60,
  fixedAmount: null,
  fixedPrice: null,
  roundTo: null,
  isActive: true,
  createdAt: '2026-10-01T10:00:00.000Z',
  tiers: [],
};

beforeEach(() => {
  apiFetchMock.mockReset();
  apiMultipartFetchMock.mockReset();
  toastSuccess.mockReset();
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/pricing-rules') return Promise.resolve({ items: [RULE], total: 1 });
    if (path === '/brands') return Promise.resolve({ items: [], total: 0 });
    if (path === `/pricing-rules/${RULE.id}/apply-all`)
      return Promise.resolve({ updated: 4, noRule: 2, message: 'server text' });
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});

// guards: BR-GOOD-011
describe('«Розцінити список» — товари без правила (№17)', () => {
  it('лічильник «Без правила» і рядок з позначкою «без правила» замість нової ціни', async () => {
    apiMultipartFetchMock.mockResolvedValue({
      found: 2,
      updated: 1,
      noRule: 1,
      notFound: [],
      details: [
        {
          goodId: 'g-ruled',
          goodName: 'Фільтр з правилом',
          sku: 'F-1',
          costPrice: 100,
          oldSalePrice: 130,
          newSalePrice: 150,
          noRule: false,
        },
        {
          goodId: 'g-free',
          goodName: 'Свічка без правила',
          sku: 'S-1',
          costPrice: 100,
          oldSalePrice: 175,
          newSalePrice: 175,
          noRule: true,
        },
      ],
    });
    const { container } = renderWithQueryClient(<PricingRulesClient />);
    await screen.findByText('Постачальник +60%');

    fireEvent.click(screen.getByRole('button', { name: 'Розцінити список' }));
    const file = new File(['sku\nS-1\n'], 'list.csv', { type: 'text/csv' });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Розцінити' }));

    const free = await screen.findByText('Свічка без правила');
    const counter = screen.getByText('Без правила:').closest('span') as HTMLElement;
    expect(within(counter).getByText('1')).toBeInTheDocument();

    const freeRow = within(free.closest('tr') as HTMLElement);
    expect(freeRow.getByText('без правила')).toBeInTheDocument();
    expect(freeRow.getByText(/175,00/)).toBeInTheDocument(); // стара ціна — та сама
    const ruledRow = within(screen.getByText('Фільтр з правилом').closest('tr') as HTMLElement);
    expect(ruledRow.queryByText('без правила')).not.toBeInTheDocument();
    expect(ruledRow.getByText(/150,00 ₴/)).toBeInTheDocument();
  });
});

// guards: BR-GOOD-011
describe('«Перерахувати» — товари без правила (№17)', () => {
  it('тост називає, скільки товарів лишилось без правила й без зміни ціни', async () => {
    renderWithQueryClient(<PricingRulesClient />);
    const row = within((await screen.findByText('Постачальник +60%')).closest('tr') as HTMLElement);

    fireEvent.click(
      row.getByRole('button', {
        name: 'Перерахувати ціни всіх відповідних товарів зараз: Постачальник +60%',
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Так' }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        'Перераховано 4 товарів; без правила — 2 (ціну не змінено)',
      ),
    );
  });
});
