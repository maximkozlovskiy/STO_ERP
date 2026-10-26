// Старі адреси прибраних сторінок оплат ведуть на нові місця (рішення власника 2026-10-14):
//   /payments                → /cash
//   /payments/<id>           → /cash   (старі посилання на картку оплати клієнта)
//   /supplier-payments       → /purchase-orders?tab=schedule
//   /supplier-payments/<id>  → /purchase-orders?tab=schedule
//
// Застосунок — статичний експорт, серверних redirect-ів немає: сторінка-оболонка лишається й
// одразу робить `router.replace` (не `push` — інакше «Назад» повертав би на адресу, яка знову
// перекидає вперед).
//
// Mutation-verify: `router.replace(to)` → `router.push(to)` → усі кейси падають; змінити адресу
// в будь-якій зі сторінок → її кейс падає.

import { render } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const replace = vi.fn();
const push = vi.fn();
const router = { replace, push };
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import { LegacyRouteRedirect } from '../LegacyRouteRedirect';
import PaymentsLegacyPage from '@/app/(app)/payments/page';
import PaymentLegacyCardPage, {
  generateStaticParams as paymentCardStaticParams,
} from '@/app/(app)/payments/[id]/page';
import SupplierPaymentsLegacyPage from '@/app/(app)/supplier-payments/page';
import SupplierPaymentLegacyCardPage, {
  generateStaticParams,
} from '@/app/(app)/supplier-payments/[id]/page';

describe('перенаправлення зі старих адрес оплат', () => {
  beforeEach(() => {
    replace.mockReset();
    push.mockReset();
  });

  it.each([
    ['/payments', PaymentsLegacyPage, '/cash'],
    ['/payments/<id>', PaymentLegacyCardPage, '/cash'],
    ['/supplier-payments', SupplierPaymentsLegacyPage, '/purchase-orders?tab=schedule'],
    ['/supplier-payments/<id>', SupplierPaymentLegacyCardPage, '/purchase-orders?tab=schedule'],
  ] as const)('%s → %s', (_from, Page, target) => {
    const { container } = render(<Page />);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(target);
    expect(push).not.toHaveBeenCalled();
    // Оболонка нічого не малює: старої сторінки на екрані немає навіть на мить.
    expect(container).toBeEmptyDOMElement();
  });

  it('картка оплати постачальнику лишає оболонку для статичного експорту', () => {
    expect(generateStaticParams()).toEqual([{ id: '_' }]);
  });

  it('картка оплати клієнта лишає оболонку для статичного експорту', () => {
    expect(paymentCardStaticParams()).toEqual([{ id: '_' }]);
  });

  it('повторний рендер із тією самою адресою не перенаправляє вдруге', () => {
    const { rerender } = render(<LegacyRouteRedirect to="/cash" />);
    rerender(<LegacyRouteRedirect to="/cash" />);
    expect(replace).toHaveBeenCalledTimes(1);
  });
});
