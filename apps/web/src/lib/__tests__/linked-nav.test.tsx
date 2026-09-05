import { renderHook } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { useLinkedNav } from '../linked-nav';

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

  it('routed detail-сторінки: work-order / supplier-payment / counterparty', () => {
    const { result } = renderHook(() => useLinkedNav());
    result.current.toWorkOrder(ID);
    result.current.toSupplierPayment(ID);
    result.current.toCounterparty(ID);
    expect(push).toHaveBeenNthCalledWith(1, `/work-orders/${ID}`);
    expect(push).toHaveBeenNthCalledWith(2, `/supplier-payments/${ID}`);
    expect(push).toHaveBeenNthCalledWith(3, `/counterparties/${ID}`);
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

  it('LinkedNav стабільний між рендерами (useMemo по router)', () => {
    const { result, rerender } = renderHook(() => useLinkedNav());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
