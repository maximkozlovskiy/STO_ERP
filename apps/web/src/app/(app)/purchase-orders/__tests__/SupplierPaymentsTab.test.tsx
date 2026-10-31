// BR-SUPPAY-014 (рішення власника 2026-10-30, TECH-DEBT (б) №36): старі чернетки оплат
// постачальнику, яких після видалення сторінки оплат ніде не було видно, — у «Купівлі», вкладка
// «Оплати постачальникам», фільтр «Чернетки» за замовчуванням. «Провести» — з ключем
// ідемпотентності (маршрут без ключа відповідає 400), «Скасувати» — без руху грошей.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { makeTestQueryClient } from '@/__tests__/query-utils';

type Init = { method?: string; headers?: Record<string, string> } | undefined;
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiPost: (path: string, body?: unknown, headers?: Record<string, string>) =>
    apiFetchMock(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(headers ? { headers } : {}),
    }),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'e1', role: 'ACCOUNTANT' } }) }));
vi.mock('@/hooks/useUiFeatures', () => ({ useUiFeatures: () => ({ toastEnabled: false }) }));

import { SupplierPaymentsTab } from '../SupplierPaymentsTab';

const DRAFT = {
  id: 'sp-1',
  number: 'ОПП-2026-000042',
  status: 'DRAFT',
  supplierName: 'АвтоДеталь ТОВ',
  sourceName: 'Грн каса',
  purchaseOrderId: 'po-1',
  purchaseOrderNumber: 'ЗАМ-2026-000007',
  amount: 300,
  currencyCode: 'USD',
  documentDate: '2026-10-20',
};

function mockList(items: unknown[] = [DRAFT]) {
  apiFetchMock.mockImplementation((path: string, init: Init) => {
    if (path.startsWith('/supplier-payments?'))
      return Promise.resolve({ items, total: items.length, page: 1, limit: 20 });
    if (init?.method === 'POST') return Promise.resolve({ id: 'sp-1' });
    return Promise.resolve({});
  });
}

const listUrls = () =>
  (apiFetchMock.mock.calls as Array<[string, Init]>)
    .map(c => c[0])
    .filter(p => p.startsWith('/supplier-payments?'));
const posts = (suffix: string) =>
  (apiFetchMock.mock.calls as Array<[string, Init]>).filter(
    c => c[0].endsWith(suffix) && c[1]?.method === 'POST',
  );

function renderTab(onOpenOrder = vi.fn()) {
  render(
    <QueryClientProvider client={makeTestQueryClient()}>
      <SupplierPaymentsTab onOpenOrder={onOpenOrder} />
    </QueryClientProvider>,
  );
  return { onOpenOrder };
}

describe('SupplierPaymentsTab — чернетки оплат постачальнику (BR-SUPPAY-014)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  // guards: BR-SUPPAY-014
  it('за замовчуванням — «Чернетки»: запит status=DRAFT, рядок із сумою у валюті оплати', async () => {
    mockList();
    renderTab();

    expect(await screen.findByText('ОПП-2026-000042')).toBeInTheDocument();
    expect(listUrls()[0]).toContain('status=DRAFT');
    const group = screen.getByRole('group', { name: 'Статус' });
    expect(within(group).getByRole('button', { name: 'Чернетки' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const row = screen.getByText('ОПП-2026-000042').closest('tr') as HTMLElement;
    expect(within(row).getByText(/300,00\sUSD/)).toBeInTheDocument();
  });

  // guards: BR-SUPPAY-014
  it('«Всі» — запит без статусу', async () => {
    mockList();
    renderTab();
    await screen.findByText('ОПП-2026-000042');
    fireEvent.click(within(screen.getByRole('group', { name: 'Статус' })).getByText('Всі'));
    await waitFor(() => expect(listUrls().some(u => !u.includes('status='))).toBe(true));
  });

  // guards: BR-SUPPAY-014
  it('«Провести» → підтвердження → POST confirm з Idempotency-Key', async () => {
    mockList();
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Провести оплату ОПП-2026-000042' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Грн каса');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Провести' }));

    await waitFor(() => expect(posts('/supplier-payments/sp-1/confirm')).toHaveLength(1));
    const key = posts('/supplier-payments/sp-1/confirm')[0][1]?.headers?.['Idempotency-Key'];
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(posts('/cancel')).toHaveLength(0);
  });

  // guards: BR-SUPPAY-014
  it('відмова проведення (замовлення скасовано) — текст над таблицею', async () => {
    mockList();
    apiFetchMock.mockImplementation((path: string, init: Init) => {
      if (path.startsWith('/supplier-payments?'))
        return Promise.resolve({ items: [DRAFT], total: 1, page: 1, limit: 20 });
      if (init?.method === 'POST')
        return Promise.reject(new Error('Оплатити можна лише замовлення «Замовлено»…'));
      return Promise.resolve({});
    });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Провести оплату ОПП-2026-000042' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Провести' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Оплатити можна лише замовлення');
  });

  // guards: BR-SUPPAY-014
  it('«Скасувати» → підтвердження → POST cancel; проведення немає', async () => {
    mockList();
    renderTab();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Скасувати чернетку ОПП-2026-000042' }),
    );
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Скасувати чернетку' }),
    );

    await waitFor(() => expect(posts('/supplier-payments/sp-1/cancel')).toHaveLength(1));
    expect(posts('/confirm')).toHaveLength(0);
  });

  // guards: BR-SUPPAY-014
  it('проведена оплата — без дій; номер замовлення відкриває його картку', async () => {
    mockList([{ ...DRAFT, status: 'CONFIRMED' }]);
    const { onOpenOrder } = renderTab();
    await screen.findByText('ОПП-2026-000042');
    expect(screen.queryByRole('button', { name: /Провести оплату/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Відкрити замовлення ЗАМ-2026-000007' }));
    expect(onOpenOrder).toHaveBeenCalledWith('po-1');
  });

  it('порожньо в «Чернетках» — пояснення, що чернеток немає', async () => {
    mockList([]);
    renderTab();
    expect(await screen.findByText(/Чернеток немає/)).toBeInTheDocument();
  });
});
