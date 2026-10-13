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

import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';

import { SupplierPaymentCreateModal } from '../SupplierPaymentCreateModal';
// Bug #593: модалка використовує React Query хуки → потрібен QueryClientProvider.
// Спільний helper (simplify/reuse) замість локальної копії.
import { renderWithQueryClient } from '../../../__tests__/query-utils';

// Схема тепер валідує supplierId/cashRegisterId через zod .uuid() (спільна web↔api) —
// фікстури мусять бути валідні UUID, інакше handleSubmit блокує submit і POST не летить.
const SUP_UUID = '11111111-1111-4111-8111-111111111111';
const CASH_UUID = '33333333-3333-4333-8333-333333333333';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
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
describe('SupplierPaymentCreateModal — idempotency (WEB-H3)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('retry після успішного create + провалу onSaved не створює дубль оплати', async () => {
    apiFetchMock.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === '/cash-registers')
        return Promise.resolve({ items: [{ id: CASH_UUID, name: 'Каса №1' }], total: 1 });
      if (path === '/bank-accounts') return Promise.resolve({ items: [], total: 0 });
      if (path === '/payment-methods')
        return Promise.resolve([{ code: 'CASH', name: 'Готівка', isActive: true }]);
      if (path === '/supplier-payments' && opts?.method === 'POST')
        return Promise.resolve({ id: 'sp1', number: 'SP-1' });
      return Promise.resolve({ items: [], total: 0 });
    });

    // onSaved кидає на першому виклику (імітує обрив ПІСЛЯ commit-у), потім успішний.
    let savedCalls = 0;
    const onSaved = vi.fn(() => {
      savedCalls += 1;
      if (savedCalls === 1) throw new Error('обрив після коміту');
    });

    renderWithQueryClient(
      <SupplierPaymentCreateModal
        open
        onClose={() => {}}
        onSaved={onSaved}
        prefill={{ supplierId: SUP_UUID, supplierName: 'Постачальник', amount: 100 }}
      />,
    );

    // Дочекатись автовибору каси (єдина) + методу оплати.
    // timeout:2000 — під повним паралельним suite async-flush голодує (усталений
    // патерн: CreateWorkOrderModal/DocumentCreateModals тести), дефолтні 1000ms
    // дають false-negative лише під навантаженням.
    await waitFor(() => expect(screen.getByText('Каса №1')).toBeInTheDocument(), { timeout: 2000 });

    const createBtn = screen.getByRole('button', { name: 'Оплатити' }) as HTMLButtonElement;
    // Кнопка активна лише коли supplierId заповнено (prefill) — дочекатись.
    await waitFor(() => expect(createBtn.disabled).toBe(false), { timeout: 2000 });

    // 1-й клік: POST створює оплату, onSaved кидає → помилка, createdIdRef=sp1.
    fireEvent.click(createBtn);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1), { timeout: 2000 });

    const postCallsAfterFirst = apiFetchMock.mock.calls.filter(
      c =>
        c[0] === '/supplier-payments' &&
        (c[1] as { method?: string } | undefined)?.method === 'POST',
    ).length;
    expect(postCallsAfterFirst).toBe(1);

    // 2-й клік (retry): create пропускається (createdIdRef), onSaved успішний.
    fireEvent.click(createBtn);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2), { timeout: 2000 });

    const postCallsAfterRetry = apiFetchMock.mock.calls.filter(
      c =>
        c[0] === '/supplier-payments' &&
        (c[1] as { method?: string } | undefined)?.method === 'POST',
    ).length;
    // Друга оплата НЕ створена — POST усе ще один.
    expect(postCallsAfterRetry).toBe(1);
  });

  // WEB-H3 double-submit: два click-и, доставлені в ОДНОМУ tick (дуже швидкий
  // double-click / синтетичні події / Enter-repeat), не мають створити дві оплати.
  // `disabled={saving}` спирається на re-render React МІЖ подіями — а тут обидва
  // click-и входять у handleSave до застосування disabled. Гейт — синхронний
  // savingRef.current (fireEvent flush-ить між кліками → потрібен нативний dispatch).
  it('два нативні click-и в одному tick створюють РІВНО 1 оплату', async () => {
    let resolvePost: () => void = () => {};
    apiFetchMock.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === '/cash-registers')
        return Promise.resolve({ items: [{ id: CASH_UUID, name: 'Каса №1' }], total: 1 });
      if (path === '/bank-accounts') return Promise.resolve({ items: [], total: 0 });
      if (path === '/payment-methods')
        return Promise.resolve([{ code: 'CASH', name: 'Готівка', isActive: true }]);
      if (path === '/supplier-payments' && opts?.method === 'POST')
        return new Promise(res => {
          resolvePost = () => res({ id: 'sp1', number: 'SP-1' });
        });
      return Promise.resolve({ items: [], total: 0 });
    });

    renderWithQueryClient(
      <SupplierPaymentCreateModal
        open
        onClose={() => {}}
        onSaved={() => {}}
        prefill={{ supplierId: SUP_UUID, supplierName: 'Постачальник', amount: 100 }}
      />,
    );

    await waitFor(() => expect(screen.getByText('Каса №1')).toBeInTheDocument(), { timeout: 2000 });
    const btn = screen.getByRole('button', { name: 'Оплатити' }) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false), { timeout: 2000 });

    // Два нативні click-и в ОДНОМУ синхронному блоці — React не встигає flush-нути
    // disabled між ними (fireEvent це замаскував би своїм sync-flush).
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      resolvePost();
    });

    const posts = apiFetchMock.mock.calls.filter(
      c =>
        c[0] === '/supplier-payments' &&
        (c[1] as { method?: string } | undefined)?.method === 'POST',
    ).length;
    expect(posts).toBe(1);
  });
});

// Сторінки оплат постачальнику немає: «Оплатити» у замовленні створює документ і одразу
// проводить його (create → confirm). Не вдалось провести — cancel і текст помилки в картці.
describe('SupplierPaymentCreateModal — create → confirm (оплата з замовлення)', () => {
  const calls = () =>
    apiFetchMock.mock.calls.map(
      c => `${(c[1] as { method?: string } | undefined)?.method ?? 'GET'} ${c[0]}`,
    );

  function mockApi(confirmFails: boolean) {
    apiFetchMock.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === '/cash-registers')
        return Promise.resolve({ items: [{ id: CASH_UUID, name: 'Каса №1' }], total: 1 });
      if (path === '/bank-accounts') return Promise.resolve({ items: [], total: 0 });
      if (path === '/payment-methods')
        return Promise.resolve([{ code: 'CASH', name: 'Готівка', isActive: true }]);
      if (path === '/supplier-payments' && opts?.method === 'POST')
        return Promise.resolve({ id: 'sp1', number: 'SP-1' });
      if (path === '/supplier-payments/sp1/confirm')
        return confirmFails
          ? Promise.reject(new Error('Недостатньо коштів у касі'))
          : Promise.resolve({ id: 'sp1', status: 'CONFIRMED' });
      if (path === '/supplier-payments/sp1/cancel')
        return Promise.resolve({ id: 'sp1', status: 'CANCELLED' });
      return Promise.resolve({ items: [], total: 0 });
    });
  }

  async function renderReady(onSaved: () => void, onClose: () => void) {
    renderWithQueryClient(
      <SupplierPaymentCreateModal
        open
        onClose={onClose}
        onSaved={onSaved}
        prefill={{ supplierId: SUP_UUID, supplierName: 'Постачальник', amount: 100 }}
      />,
    );
    await waitFor(() => expect(screen.getByText('Каса №1')).toBeInTheDocument(), { timeout: 2000 });
    const btn = screen.getByRole('button', { name: 'Оплатити' }) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false), { timeout: 2000 });
    return btn;
  }

  beforeEach(() => {
    apiFetchMock.mockReset();
    window.sessionStorage.clear();
  });

  it('успіх: POST → confirm, картка закривається, cancel не викликається', async () => {
    mockApi(false);
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const btn = await renderReady(onSaved, onClose);
    fireEvent.click(btn);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls()).toContain('POST /supplier-payments');
    expect(calls()).toContain('POST /supplier-payments/sp1/confirm');
    expect(calls()).not.toContain('POST /supplier-payments/sp1/cancel');
  });

  it('confirm впав: cancel викликано, картка не закрилась, текст помилки видно', async () => {
    mockApi(true);
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const btn = await renderReady(onSaved, onClose);
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText('Недостатньо коштів у касі')).toBeInTheDocument(), {
      timeout: 2000,
    });
    expect(calls()).toContain('POST /supplier-payments/sp1/cancel');
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('подвійний клік в одному tick: один документ і одне проведення', async () => {
    mockApi(false);
    const btn = await renderReady(vi.fn(), vi.fn());
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => expect(calls()).toContain('POST /supplier-payments/sp1/confirm'), {
      timeout: 2000,
    });
    expect(calls().filter(c => c === 'POST /supplier-payments')).toHaveLength(1);
    expect(calls().filter(c => c === 'POST /supplier-payments/sp1/confirm')).toHaveLength(1);
  });
});
