// Regression-guard для SupplierPaymentCreateModal — джерело коштів (каса/банк).
//
// Bug guarded (code-review 2026-08-20, family Bug #592):
//   Модалка ділить sessionStorage-ключ 'cache:bank-accounts' з /ndi BankAccountsTab
//   (зберігає форму { items: [...] }) і самосіє 'cache:cash-registers' з /cash-registers.
//   Раніше модалка читала/писала ГОЛИЙ масив → конфлікт форм: коли модалка читала
//   об'єкт { items } з таба (truthy) і клала його у setBanks → banks.map crash
//   (особливо коли offline apiFetch падав і .catch ковтав помилку — first-class
//   сценарій offline-first ERP).
//
// Fix: модалка читає { items } з Array.isArray guard і пише { items } (той самий
// контракт що таби + API-відповідь). Ці тести фіксують обидві сторони.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';

import { SupplierPaymentCreateModal } from '../SupplierPaymentCreateModal';
// Bug #593: модалка використовує React Query хуки → потрібен QueryClientProvider.
// Спільний helper (simplify/reuse) замість локальної копії.
import { makeTestQueryClient, renderWithQueryClient } from '../../../__tests__/query-utils';

// Схема тепер валідує supplierId/cashRegisterId через zod .uuid() (спільна web↔api) —
// фікстури мусять бути валідні UUID, інакше handleSubmit блокує submit і POST не летить.
const SUP_UUID = '11111111-1111-4111-8111-111111111111';
const CASH_UUID = '33333333-3333-4333-8333-333333333333';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  // apiPost — тонка обгортка над apiFetch (як справжня): шлях, метод і заголовки видно в моку.
  apiPost: (path: string, body?: unknown, headers?: Record<string, string>) =>
    apiFetchMock(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(headers ? { headers } : {}),
    }),
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false }),
}));

describe('SupplierPaymentCreateModal — cache-shape regression (family Bug #592)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('не крашиться коли cache має { items } форму (з таба) а apiFetch падає offline', async () => {
    // Таб записав канонічну форму { items }.
    window.sessionStorage.setItem(
      'cache:bank-accounts',
      JSON.stringify({ items: [{ id: 'ba1', name: 'Основний' }], total: 1 }),
    );
    window.sessionStorage.setItem(
      'cache:cash-registers',
      JSON.stringify({ items: [{ id: CASH_UUID, name: 'Каса №1' }], total: 1 }),
    );
    // Offline: усі reference-fetch падають (як у реальному offline-first сценарії).
    apiFetchMock.mockRejectedValue(new Error('offline'));

    expect(() =>
      renderWithQueryClient(
        <SupplierPaymentCreateModal open onClose={() => {}} onSaved={() => {}} />,
      ),
    ).not.toThrow();
    // Модалка відрендерилась, дефолтне джерело CASH_REGISTER → каса з кешу присутня.
    await waitFor(() => expect(screen.getByText('Каса №1')).toBeInTheDocument(), { timeout: 2000 });
  });

  it('не крашиться коли cache — голий масив (стара форма модалки)', async () => {
    window.sessionStorage.setItem(
      'cache:cash-registers',
      JSON.stringify([{ id: CASH_UUID, name: 'Каса №1' }]),
    );
    apiFetchMock.mockRejectedValue(new Error('offline'));

    expect(() =>
      renderWithQueryClient(
        <SupplierPaymentCreateModal open onClose={() => {}} onSaved={() => {}} />,
      ),
    ).not.toThrow();
  });

  it('пише у cache канонічну { items } форму (не голий масив)', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/bank-accounts')
        return Promise.resolve({ items: [{ id: 'ba1', name: 'Основний' }], total: 1 });
      if (path === '/cash-registers')
        return Promise.resolve({ items: [{ id: CASH_UUID, name: 'Каса №1' }], total: 1 });
      if (path === '/payment-methods') return Promise.resolve([]);
      return Promise.resolve({ items: [], total: 0 });
    });

    renderWithQueryClient(
      <SupplierPaymentCreateModal open onClose={() => {}} onSaved={() => {}} />,
    );

    await waitFor(() => {
      const raw = window.sessionStorage.getItem('cache:bank-accounts');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw as string);
      // Канонічна форма — об'єкт з масивом items, НЕ голий масив.
      expect(Array.isArray(parsed)).toBe(false);
      expect(Array.isArray(parsed.items)).toBe(true);
    });
  });
});

// WEB-H3: подвійний submit після успішного create (обрив на відповіді) не має
// створити ДРУГУ оплату. Guard: createdIdRef зберігає id першого успіху →
// повторний клік «Оплатити» пропускає POST /supplier-payments.
// BR-SUPPAY-013 (рішення власника 2026-10-30, TECH-DEBT (б) №34): «Оплатити» — ОДНА дія
// `POST /supplier-payments/pay` з ключем ідемпотентності на відкриття вікна. До того web слав
// create → confirm (без ключа — 400 з 2026-10-25) → cancel і лишав скасовану чернетку (Bug #1020).
describe('SupplierPaymentCreateModal — оплата однією дією (BR-SUPPAY-013)', () => {
  type Call = [string, { method?: string; headers?: Record<string, string> } | undefined];
  const payCalls = () =>
    (apiFetchMock.mock.calls as Call[]).filter(
      c => c[0] === '/supplier-payments/pay' && c[1]?.method === 'POST',
    );
  const methodPaths = () =>
    (apiFetchMock.mock.calls as Call[]).map(c => `${c[1]?.method ?? 'GET'} ${c[0]}`);

  function mockApi(pay: () => Promise<unknown> = () => Promise.resolve({ id: 'sp1' })) {
    apiFetchMock.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === '/cash-registers')
        return Promise.resolve({ items: [{ id: CASH_UUID, name: 'Каса №1' }], total: 1 });
      if (path === '/bank-accounts') return Promise.resolve({ items: [], total: 0 });
      if (path === '/payment-methods')
        return Promise.resolve([{ code: 'cash', name: 'Готівка', isActive: true }]);
      if (path === '/supplier-payments/pay' && opts?.method === 'POST') return pay();
      return Promise.resolve({ items: [], total: 0 });
    });
  }

  async function renderReady(
    onSaved: () => void = () => {},
    onClose: () => void = () => {},
    open = true,
  ) {
    const client = makeTestQueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <SupplierPaymentCreateModal
          open={open}
          onClose={onClose}
          onSaved={onSaved}
          prefill={{ supplierId: SUP_UUID, supplierName: 'Постачальник', amount: 100 }}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('Каса №1')).toBeInTheDocument(), { timeout: 2000 });
    const btn = screen.getByRole('button', { name: 'Оплатити' }) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false), { timeout: 2000 });
    return { btn, view, client };
  }

  beforeEach(() => {
    apiFetchMock.mockReset();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    window.sessionStorage.clear();
  });

  // guards: BR-SUPPAY-013
  it('успіх: один POST /pay з Idempotency-Key; ні /supplier-payments, ні confirm, ні cancel; картка закрита', async () => {
    mockApi();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const { btn } = await renderReady(onSaved, onClose);

    fireEvent.click(btn);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1), { timeout: 2000 });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(payCalls()).toHaveLength(1);
    expect(payCalls()[0][1]?.headers?.['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    const paths = methodPaths();
    expect(paths).not.toContain('POST /supplier-payments');
    expect(paths.some(p => p.endsWith('/confirm') || p.endsWith('/cancel'))).toBe(false);
  });

  // guards: BR-SUPPAY-013
  it('відмова сервера: текст у картці, картка відкрита, нічого не скасовують', async () => {
    mockApi(() => Promise.reject(new Error('Недостатньо готівки в касі: доступно 10,00')));
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const { btn } = await renderReady(onSaved, onClose);

    fireEvent.click(btn);

    expect(
      await screen.findByText(/Недостатньо готівки в касі/, {}, { timeout: 2000 }),
    ).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(methodPaths().some(p => p.endsWith('/cancel'))).toBe(false);
  });

  // Обрив відповіді ПІСЛЯ проведення (тут — onSaved кидає): повтор іде з ТИМ САМИМ ключем, тож
  // сервер віддає збережену оплату, а не проводить другу.
  // guards: BR-SUPPAY-013
  it('повтор у тому ж відкритті — той самий ключ', async () => {
    mockApi();
    let savedCalls = 0;
    const onSaved = vi.fn(() => {
      savedCalls += 1;
      if (savedCalls === 1) throw new Error('обрив після проведення');
    });
    const { btn } = await renderReady(onSaved);

    fireEvent.click(btn);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1), { timeout: 2000 });
    fireEvent.click(btn);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2), { timeout: 2000 });

    const keys = payCalls().map(c => c[1]?.headers?.['Idempotency-Key']);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  // guards: BR-SUPPAY-013
  it('нове відкриття вікна — новий ключ', async () => {
    mockApi();
    const { btn, view, client } = await renderReady();
    fireEvent.click(btn);
    await waitFor(() => expect(payCalls()).toHaveLength(1), { timeout: 2000 });

    const reopen = (open: boolean) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <SupplierPaymentCreateModal
            open={open}
            onClose={() => {}}
            onSaved={() => {}}
            prefill={{ supplierId: SUP_UUID, supplierName: 'Постачальник', amount: 100 }}
          />
        </QueryClientProvider>,
      );
    reopen(false);
    reopen(true);
    const again = await screen.findByRole('button', { name: 'Оплатити' });
    await waitFor(() => expect((again as HTMLButtonElement).disabled).toBe(false), {
      timeout: 2000,
    });
    await waitFor(() => expect(screen.getByText('Каса №1')).toBeInTheDocument());
    fireEvent.click(again);
    await waitFor(() => expect(payCalls()).toHaveLength(2), { timeout: 2000 });

    const keys = payCalls().map(c => c[1]?.headers?.['Idempotency-Key']);
    expect(keys[1]).not.toBe(keys[0]);
  });

  // WEB-H3 double-submit: два click-и, доставлені в ОДНОМУ tick, не мають дати двох запитів.
  // Гейт — синхронний savingRef.current (fireEvent flush-ить між кліками → нативний dispatch).
  // guards: BR-SUPPAY-013
  it('два нативні click-и в одному tick — РІВНО один POST /pay', async () => {
    let resolvePay: () => void = () => {};
    mockApi(
      () =>
        new Promise(res => {
          resolvePay = () => res({ id: 'sp1' });
        }),
    );
    const { btn } = await renderReady();

    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      resolvePay();
    });

    expect(payCalls()).toHaveLength(1);
  });

  // Підстава оплати — лише «Замовлено» / «Частково» / «Отримано»: пікер просить `payable=true`.
  // guards: BR-SUPPAY-015
  it('пікер замовлення просить лише замовлення, що приймають оплату', async () => {
    mockApi();
    await renderReady();
    const pickers = screen.getAllByRole('button', { name: 'Обрати' });
    fireEvent.click(pickers[pickers.length - 1]);

    await waitFor(
      () =>
        expect(
          (apiFetchMock.mock.calls as Call[]).some(
            c => c[0].startsWith('/purchase-orders?') && c[0].includes('payable=true'),
          ),
        ).toBe(true),
      { timeout: 2000 },
    );
  });
});
