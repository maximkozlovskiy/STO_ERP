import { renderHook } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { useLinkedNav, resolvePurchaseOrdersDeepLink } from '../linked-nav';

// Мокаємо next/navigation useRouter — перевіряємо саме URL-контракт навігації.
const push = vi.fn();
// Стабільний router-об'єкт (як справжній next useRouter) — інакше useMemo([router])
// перераховувався б щорендер через новий identity.
const router = { push };
vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

const ID = '11111111-1111-4111-8111-111111111111';

describe('useLinkedNav — URL-контракт deep-link навігації', () => {
  beforeEach(() => push.mockReset());

  it('routed detail-сторінки: work-order / counterparty', () => {
    const { result } = renderHook(() => useLinkedNav());
    result.current.toWorkOrder(ID);
    result.current.toCounterparty(ID);
    expect(push).toHaveBeenNthCalledWith(1, `/work-orders/${ID}`);
    expect(push).toHaveBeenNthCalledWith(2, `/counterparties/${ID}`);
  });

  // Сторінок оплат немає: перехід до оплати вів би на адресу-перенаправлення, а не на документ.
  it('переходу до оплати постачальнику немає — жоден метод не веде на сторінки оплат', () => {
    const { result } = renderHook(() => useLinkedNav());
    expect(Object.keys(result.current)).not.toContain('toSupplierPayment');
    for (const [name, go] of Object.entries(result.current)) {
      if (name !== 'toCalendarDay') go(ID);
    }
    const targets = push.mock.calls.map(c => String(c[0]));
    expect(targets.filter(u => /^\/(supplier-)?payments(\/|\?|$)/.test(u))).toEqual([]);
  });

  it('modal-списки через ?open= : invoice / purchase-order / stock-document', () => {
    const { result } = renderHook(() => useLinkedNav());
    result.current.toInvoice(ID);
    result.current.toPurchaseOrder(ID);
    result.current.toStockDocument(ID);
    expect(push).toHaveBeenNthCalledWith(1, `/invoices?open=${ID}`);
    expect(push).toHaveBeenNthCalledWith(2, `/purchase-orders?open=${ID}`);
    expect(push).toHaveBeenNthCalledWith(3, `/stock-documents?open=${ID}`);
  });

  it('supplier-return використовує ОКРЕМИЙ param ?openReturn= (не колідує з ?open= PO)', () => {
    const { result } = renderHook(() => useLinkedNav());
    result.current.toSupplierReturn(ID);
    // Дискримінатор: якби використовувався ?open=, повернення відкрило б edit-modal PO.
    expect(push).toHaveBeenCalledWith(`/purchase-orders?openReturn=${ID}`);
    expect(push).not.toHaveBeenCalledWith(`/purchase-orders?open=${ID}`);
  });

  // guards: BR-WAR-005
  it('гарантія → вкладка «Гарантії» нарядів, `open=` відкриває її в панелі', () => {
    const { result } = renderHook(() => useLinkedNav());
    result.current.toWarranty(ID);
    expect(push).toHaveBeenCalledWith(`/work-orders?tab=warranties&open=${ID}`);
  });

  it('список купівлі → вкладка «Управління купівлями», вид «Списки», картка списку', () => {
    const { result } = renderHook(() => useLinkedNav());
    result.current.toPurchaseList(ID);
    expect(push).toHaveBeenCalledWith(`/purchase-orders?tab=procurement&view=lists&list=${ID}`);
  });

  it('запис календаря → календар у режимі дня на КИЇВСЬКОМУ дні запису', () => {
    const { result } = renderHook(() => useLinkedNav());
    // 10.06 о 19:00 за Києвом = 16:00 UTC.
    result.current.toCalendarDay('2026-06-10T16:00:00.000Z');
    expect(push).toHaveBeenNthCalledWith(1, '/calendar?view=day&date=2026-06-10');
    // 22:30 UTC 10.06 — у Києві вже 11.06, 01:30: день береться київський, не UTC.
    result.current.toCalendarDay('2026-06-10T22:30:00.000Z');
    expect(push).toHaveBeenNthCalledWith(2, '/calendar?view=day&date=2026-06-11');
  });

  it('LinkedNav стабільний між рендерами (useMemo по router)', () => {
    const { result, rerender } = renderHook(() => useLinkedNav());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolvePurchaseOrdersDeepLink — розбір ?open= / ?openReturn= на сторінці замовлень.
//
// BUG (знайдено sto-tester, Phase D): deep-link `?openReturn=<id>` виставляв лише
// srEditId, але SR-модалка на сторінці — ОДИН інстанс з open={srCreateOpen}. Без
// setSrCreateOpen(true) editId виставлявся, а open лишався false → модалка НІКОЛИ
// не відкривалась (toSupplierReturn deep-link мертвий). `srModalShouldOpen` тепер
// явно каже сторінці відкрити модалку.
//
// Дискримінатор: якщо ментально відкотити фікс (srModalShouldOpen завжди false /
// не виставляти open) — цей тест впаде на `expect(...srModalShouldOpen).toBe(true)`.
// ─────────────────────────────────────────────────────────────────────────────
describe('resolvePurchaseOrdersDeepLink', () => {
  const from = (params: Record<string, string>) => (k: string) => params[k] ?? null;

  it('?openReturn=<valid uuid> → openSupplierReturnId + srModalShouldOpen=true (модалку треба відкрити)', () => {
    const res = resolvePurchaseOrdersDeepLink(from({ openReturn: ID }));
    expect(res.openSupplierReturnId).toBe(ID);
    // КРИТИЧНИЙ дискримінатор бага: без цього SR-модалка з open={srCreateOpen}
    // лишалась би закритою.
    expect(res.srModalShouldOpen).toBe(true);
    expect(res.openPurchaseOrderId).toBeNull();
  });

  it('?open=<valid uuid> → openPurchaseOrderId; SR-модалка НЕ відкривається', () => {
    const res = resolvePurchaseOrdersDeepLink(from({ open: ID }));
    expect(res.openPurchaseOrderId).toBe(ID);
    expect(res.openSupplierReturnId).toBeNull();
    expect(res.srModalShouldOpen).toBe(false);
  });

  it('обидва params одночасно → PO і SR відкриваються незалежно', () => {
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const res = resolvePurchaseOrdersDeepLink(from({ open: ID, openReturn: OTHER }));
    expect(res.openPurchaseOrderId).toBe(ID);
    expect(res.openSupplierReturnId).toBe(OTHER);
    expect(res.srModalShouldOpen).toBe(true);
  });

  it('невалідний / відсутній UUID → усе null, srModalShouldOpen=false (без спаму модалки на refresh)', () => {
    expect(resolvePurchaseOrdersDeepLink(from({}))).toEqual({
      openPurchaseOrderId: null,
      openSupplierReturnId: null,
      srModalShouldOpen: false,
    });
    expect(resolvePurchaseOrdersDeepLink(from({ openReturn: 'not-a-uuid' }))).toEqual({
      openPurchaseOrderId: null,
      openSupplierReturnId: null,
      srModalShouldOpen: false,
    });
  });
});
