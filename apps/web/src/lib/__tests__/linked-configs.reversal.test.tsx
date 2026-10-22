// «Пов'язані документи» після сторно касової операції (BR-CASH-024).
//
// Що стереже:
//   - оплата з `reversedAt` у рахунку й наряді: позначка «Сторновано» (замість чека) і рядок
//     прев'ю з датою сторно; «Повторити» чек не пропонується навіть для FAILED — чек
//     сторнованої оплати сервер скасовує;
//   - оплата постачальнику: колір позначки — зі спільної мапи `SUPPLIER_PAYMENT_STATUS_BADGE`,
//     «Сторновано» (REVERSED) — червона, а не сіра, як було для всіх статусів;
//   - панель малює позначку з `variant` спільним `<Badge>`.
//
// Mutation-verify:
//   - прибрати `&& !row.reversedAt` з умови дії → «без Повторити» падає;
//   - `row.reversedAt ? REVERSED_PAYMENT_BADGE : …` → лише fiscalBadge → «позначка Сторновано» падає;
//   - повернути `className: 'bg-secondary text-muted-foreground'` у supplierPaymentSection →
//     «REVERSED червона» падає.

import { render, screen, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
// Рядок оплати несе дію «Сторнувати» за роллю (BR-PAY-024) — панелі потрібна роль користувача.
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { role: 'ACCOUNTANT' } }) }));
vi.mock('@/lib/format', () => ({
  fmtMoney: (v: number) => String(v),
  fmtDate: (v: string) => `дата ${v.slice(0, 10)}`,
  fmtDateTime: (v: string) => `дата ${v.slice(0, 10)}`,
}));

import { LinkedDocumentsPanel } from '@/components/ui/LinkedDocumentsPanel';
import {
  invoiceLinkedConfig,
  workOrderLinkedConfig,
  purchaseOrderLinkedConfig,
  counterpartyLinkedConfig,
} from '../linked-configs';
import type { LinkedNav } from '../linked-nav';

const nav = {
  toWorkOrder: vi.fn(),
  toCounterparty: vi.fn(),
  toInvoice: vi.fn(),
  toPurchaseOrder: vi.fn(),
  toStockDocument: vi.fn(),
  toSupplierReturn: vi.fn(),
  toCalendarDay: vi.fn(),
  toWarranty: vi.fn(),
} as unknown as LinkedNav;

const ID = '11111111-1111-4111-8111-111111111111';

const payment = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  amount: 800,
  method: 'CASH',
  createdAt: '2026-10-10T09:00:00.000Z',
  notes: null,
  fiscalStatus: 'FAILED',
  reversedAt: null,
  ...over,
});

const paymentsSection = (config: ReturnType<typeof invoiceLinkedConfig>) => {
  const s = config.sections.find(x => x.key === 'payments');
  if (!s) throw new Error('payments section missing');
  return s;
};

describe('оплата контрагента, сторнована з каси', () => {
  it("рахунок: «Сторновано» замість чека, без «Повторити», дата сторно в прев'ю", () => {
    const retryFiscal = vi.fn();
    const mapped = paymentsSection(invoiceLinkedConfig(nav, { retryFiscal })).mapRow(
      payment({ reversedAt: '2026-10-14T12:00:00.000Z' }),
    );
    expect(mapped.badge).toEqual({ label: 'Сторновано', variant: 'destructive' });
    expect(mapped.action).toBeUndefined();
    expect(mapped.preview.rows).toContainEqual({ label: 'Сторновано', value: 'дата 2026-10-14' });
  });

  it('рахунок: несторнована FAILED-оплата — як і раніше, чек і «Повторити»', () => {
    const mapped = paymentsSection(invoiceLinkedConfig(nav, { retryFiscal: vi.fn() })).mapRow(
      payment(),
    );
    expect(mapped.badge?.label).toBe('Чек: Помилка');
    expect(mapped.action?.label).toBe('Повторити');
    expect(mapped.preview.rows.map(r => r.label)).not.toContain('Сторновано');
  });

  it('наряд: сторнована оплата позначена, звичайна — без позначки', () => {
    const section = paymentsSection(workOrderLinkedConfig(nav));
    expect(section.mapRow(payment({ reversedAt: '2026-10-14T12:00:00.000Z' })).badge?.label).toBe(
      'Сторновано',
    );
    expect(section.mapRow(payment()).badge).toBeUndefined();
  });

  describe('у панелі', () => {
    beforeEach(() => apiFetchMock.mockReset());

    it('рядок сторнованої оплати має позначку «Сторновано» і не має «Повторити»', async () => {
      apiFetchMock.mockResolvedValue({
        workOrder: [],
        counterparty: [],
        payments: [
          payment({ id: 'p-rev', amount: 500, reversedAt: '2026-10-14T12:00:00.000Z' }),
          payment({ id: 'p-ok', amount: 300 }),
        ],
      });
      render(
        <LinkedDocumentsPanel
          config={invoiceLinkedConfig(nav, { retryFiscal: vi.fn() })}
          entityId={ID}
        />,
      );
      const reversedLabel = await screen.findByText('Сторновано');
      // Спільний <Badge variant="destructive">, а не сіра «таблетка».
      expect(reversedLabel.className).toContain('bg-destructive-subtle');
      const reversedRow = screen.getByText('500 ₴').closest('div.flex') as HTMLElement;
      expect(within(reversedRow).queryByRole('button', { name: 'Повторити' })).toBeNull();
      // Інша (несторнована) оплата з FAILED-чеком «Повторити» має.
      expect(screen.getAllByRole('button', { name: 'Повторити' })).toHaveLength(1);
    });
  });
});

describe('оплата постачальнику зі статусом «Сторновано»', () => {
  const row = (status: string) => ({
    id: `sp-${status}`,
    number: `ОПП-${status}`,
    amount: 1500,
    method: 'CASH',
    status,
    documentDate: '2026-10-14',
  });

  it.each([
    ['замовлення', purchaseOrderLinkedConfig],
    ['картка контрагента', counterpartyLinkedConfig],
  ] as const)('%s: колір — зі спільної мапи статусів', (_name, factory) => {
    const section = factory(nav).sections.find(x => x.key === 'supplierPayments');
    if (!section) throw new Error('supplierPayments section missing');
    expect(section.mapRow(row('REVERSED')).badge).toEqual({
      label: 'Сторновано',
      variant: 'destructive',
    });
    expect(section.mapRow(row('CONFIRMED')).badge).toEqual({
      label: 'Проведено',
      variant: 'success',
    });
  });

  it('у панелі замовлення: «Сторновано» — червона позначка', async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ supplierPayments: [row('REVERSED')], counterparty: [] });
    render(<LinkedDocumentsPanel config={purchaseOrderLinkedConfig(nav)} entityId={ID} />);
    const label = await screen.findByText('Сторновано');
    expect(label.className).toContain('bg-destructive-subtle');
  });
});
