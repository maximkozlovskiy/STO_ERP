// Regression-guard для SupplierPaymentCreateModal — джерело коштів (каса/банк).
//
// Bug guarded (code-review 2026-08-20, family Bug #592):
//   Модалка ділить sessionStorage-ключі 'cache:bank-accounts' / 'cache:cash-registers'
//   з /ndi BankAccountsTab та CashRegistersTab, які зберігають форму { items: [...] }.
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
      JSON.stringify({ items: [{ id: 'cr1', name: 'Каса №1' }], total: 1 }),
    );
    // Offline: усі reference-fetch падають (як у реальному offline-first сценарії).
    apiFetchMock.mockRejectedValue(new Error('offline'));

    expect(() =>
      renderWithQueryClient(
        <SupplierPaymentCreateModal open onClose={() => {}} onSaved={() => {}} />,
      ),
    ).not.toThrow();
    // Модалка відрендерилась, дефолтне джерело CASH_REGISTER → каса з кешу присутня.
    await waitFor(() => expect(screen.getByText('Каса №1')).toBeInTheDocument());
  });

  it('не крашиться коли cache — голий масив (стара форма модалки)', async () => {
    window.sessionStorage.setItem(
      'cache:cash-registers',
      JSON.stringify([{ id: 'cr1', name: 'Каса №1' }]),
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
        return Promise.resolve({ items: [{ id: 'cr1', name: 'Каса №1' }], total: 1 });
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
// повторний клік «Створити оплату» пропускає POST /supplier-payments.
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
        return Promise.resolve({ items: [{ id: 'cr1', name: 'Каса №1' }], total: 1 });
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
        prefill={{ supplierId: 'sup1', supplierName: 'Постачальник', amount: 100 }}
      />,
    );

    // Дочекатись автовибору каси (єдина) + методу оплати.
    await waitFor(() => expect(screen.getByText('Каса №1')).toBeInTheDocument());

    const createBtn = screen.getByRole('button', { name: 'Створити оплату' }) as HTMLButtonElement;
    // Кнопка активна лише коли supplierId заповнено (prefill) — дочекатись.
    await waitFor(() => expect(createBtn.disabled).toBe(false));

    // 1-й клік: POST створює оплату, onSaved кидає → помилка, createdIdRef=sp1.
    fireEvent.click(createBtn);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));

    const postCallsAfterFirst = apiFetchMock.mock.calls.filter(
      c =>
        c[0] === '/supplier-payments' &&
        (c[1] as { method?: string } | undefined)?.method === 'POST',
    ).length;
    expect(postCallsAfterFirst).toBe(1);

    // 2-й клік (retry): create пропускається (createdIdRef), onSaved успішний.
    fireEvent.click(createBtn);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));

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
        return Promise.resolve({ items: [{ id: 'cr1', name: 'Каса №1' }], total: 1 });
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
        prefill={{ supplierId: 'sup1', supplierName: 'Постачальник', amount: 100 }}
      />,
    );

    await waitFor(() => expect(screen.getByText('Каса №1')).toBeInTheDocument());
    const btn = screen.getByRole('button', { name: 'Створити оплату' }) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));

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
