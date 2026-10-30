// «Пов'язані документи» наряду й рахунку: дія «Сторнувати» оплати (BR-PAY-024).
//
// Що стереже:
//   - дія є лише в не сторнованої, не касової й не онлайн-оплати (QR); касова — підказка
//     «Сторнується в касі»; сторнована й QR — ні дії, ні підказки;
//   - кнопку й підказку бачать лише OWNER / ADMIN / ACCOUNTANT (ролі маршруту);
//   - кнопка відкриває картку сторно; після сторно панель перечитує пов'язані документи.
//
// Mutation-verify:
//   - прибрати `row.sourceType === 'CASH_REGISTER'` гілку → «касова: підказка» падає;
//   - прибрати `row.inCashDesk ||` → «стара готівкова без призначення» падає;
//   - прибрати `|| row.isOnline` → «QR без дії» падає;
//   - `allowed` у RowDialogAction → завжди true → «приймальня не бачить» падає;
//   - прибрати `onDone: () => setRetryKey(...)` у панелі → «панель перечитується» падає.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiMultipartFetch: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/format', () => ({
  fmtMoney: (v: number) => String(v),
  fmtDate: (v: string) => `дата ${v.slice(0, 10)}`,
  fmtDateTime: (v: string) => `дата ${v.slice(0, 10)}`,
}));
const auth = vi.hoisted(() => ({ role: 'ACCOUNTANT' as string | null }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: auth.role ? { role: auth.role } : null }),
}));

import { LinkedDocumentsPanel } from '@/components/ui/LinkedDocumentsPanel';
import { invoiceLinkedConfig, workOrderLinkedConfig } from '../linked-configs';
import type { LinkedNav } from '../linked-nav';
import { makeTestQueryClient } from '@/__tests__/query-utils';

const nav = {
  toWorkOrder: vi.fn(),
  toCounterparty: vi.fn(),
  toInvoice: vi.fn(),
  toCalendarDay: vi.fn(),
  toWarranty: vi.fn(),
  toPurchaseList: vi.fn(),
} as unknown as LinkedNav;

const ID = '11111111-1111-4111-8111-111111111111';
const PAY = 'p-bank';

const payment = (over: Record<string, unknown> = {}) => ({
  id: PAY,
  amount: 100,
  method: 'bank',
  createdAt: '2026-10-20T09:00:00.000Z',
  notes: null,
  fiscalStatus: null,
  reversedAt: null,
  sourceType: 'BANK_ACCOUNT',
  isOnline: false,
  ...over,
});

const section = (config: ReturnType<typeof workOrderLinkedConfig>) => {
  const s = config.sections.find(x => x.key === 'payments');
  if (!s) throw new Error('payments section missing');
  return s;
};

function renderPanel(
  rows: Array<Record<string, unknown>>,
  config: ReturnType<typeof workOrderLinkedConfig> = workOrderLinkedConfig(nav),
) {
  apiFetchMock.mockImplementation((path: string) =>
    path.endsWith('/reverse')
      ? Promise.resolve({ id: PAY })
      : Promise.resolve({ invoices: [], payments: rows, calendarSlots: [], warranties: [] }),
  );
  return render(
    <QueryClientProvider client={makeTestQueryClient()}>
      <LinkedDocumentsPanel config={config} entityId={ID} />
    </QueryClientProvider>,
  );
}

const linkedFetches = () =>
  apiFetchMock.mock.calls.filter(c => String(c[0]).endsWith('/linked-documents'));

describe('рядок оплати: дія чи підказка (BR-PAY-024)', () => {
  // guards: BR-PAY-024
  it.each([
    ['банківська', payment(), 'action'],
    ['стара без призначення', payment({ sourceType: null }), 'action'],
    ['касова', payment({ sourceType: 'CASH_REGISTER' }), 'hint'],
    // Стара готівкова оплата (до BR-PAY-023): `sourceType` немає, а рядок каси є — сервер
    // відхиляє сторно `err.payment.reversalCashRow`, тож і тут підказка, не кнопка.
    ['стара готівкова без призначення', payment({ sourceType: null, inCashDesk: true }), 'hint'],
    ['онлайн QR', payment({ sourceType: null, isOnline: true }), 'none'],
    ['сторнована', payment({ reversedAt: '2026-10-21T09:00:00.000Z' }), 'none'],
  ])('%s → %s', (_n, row, expected) => {
    for (const config of [workOrderLinkedConfig(nav), invoiceLinkedConfig(nav)]) {
      const mapped = section(config).mapRow(row);
      expect(mapped.dialogAction ? 'action' : mapped.actionHint ? 'hint' : 'none').toBe(expected);
      if (mapped.dialogAction) {
        expect(mapped.dialogAction.label).toBe('Сторнувати');
        expect([...(mapped.dialogAction.roles ?? [])].sort()).toEqual([
          'ACCOUNTANT',
          'ADMIN',
          'OWNER',
        ]);
      }
      if (mapped.actionHint) expect(mapped.actionHint.text).toBe('Сторнується в касі');
    }
  });
});

// Рішення власника 2026-10-30 (TECH-DEBT (б) №43): поки чек у черзі ПРРО, сторно відмовляє
// (BR-PAY-029) — замість кнопки підказка, тим самим ролям.
describe('рядок оплати: чек у черзі ПРРО (BR-PAY-029)', () => {
  // guards: BR-PAY-029
  it.each([
    ['банківська', payment({ fiscalStatus: 'QUEUED' })],
    ['касова', payment({ sourceType: 'CASH_REGISTER', fiscalStatus: 'QUEUED' })],
  ])('%s, чек QUEUED → підказка про ПРРО замість «Сторнувати»', (_n, row) => {
    for (const config of [workOrderLinkedConfig(nav), invoiceLinkedConfig(nav)]) {
      const mapped = section(config).mapRow(row);
      expect(mapped.dialogAction).toBeUndefined();
      expect(mapped.actionHint?.text).toMatch(/ПРРО/);
      expect([...(mapped.actionHint?.roles ?? [])].sort()).toEqual([
        'ACCOUNTANT',
        'ADMIN',
        'OWNER',
      ]);
    }
  });

  // guards: BR-PAY-029
  it('чек FAILED → «Сторнувати» лишається (відхилений чек сторно знімає)', () => {
    const mapped = section(workOrderLinkedConfig(nav)).mapRow(payment({ fiscalStatus: 'FAILED' }));
    expect(mapped.dialogAction?.label).toBe('Сторнувати');
  });
});

describe('панель: ролі й картка сторно', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    auth.role = 'ACCOUNTANT';
  });

  // guards: BR-PAY-024
  it.each(['OWNER', 'ADMIN', 'ACCOUNTANT'])('%s бачить «Сторнувати»', async role => {
    auth.role = role;
    renderPanel([payment()]);
    expect(await screen.findByRole('button', { name: /Сторнувати оплату 100 ₴/ })).toBeVisible();
  });

  // guards: BR-PAY-024
  it.each(['RECEPTIONIST', 'MECHANIC'])(
    '%s не бачить ні «Сторнувати», ні підказки каси',
    async role => {
      auth.role = role;
      renderPanel([payment(), payment({ id: 'p-cash', sourceType: 'CASH_REGISTER' })]);
      await screen.findAllByText('100 ₴');
      expect(screen.queryByRole('button', { name: /Сторнувати/ })).toBeNull();
      expect(screen.queryByText('Сторнується в касі')).toBeNull();
    },
  );

  // guards: BR-PAY-024
  it('касова оплата: підказка «Сторнується в касі» замість кнопки', async () => {
    renderPanel([payment({ sourceType: 'CASH_REGISTER' })]);
    expect(await screen.findByText('Сторнується в касі')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Сторнувати/ })).toBeNull();
  });

  // guards: BR-PAY-024
  it("«Сторнувати» відкриває картку; після сторно панель перечитує пов'язані документи", async () => {
    renderPanel([payment()], invoiceLinkedConfig(nav));
    fireEvent.click(await screen.findByRole('button', { name: /Сторнувати оплату 100 ₴/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Сторно оплати' });
    expect(within(dialog).getByText('100 ₴')).toBeInTheDocument();
    expect(linkedFetches()).toHaveLength(1);

    fireEvent.change(within(dialog).getByLabelText(/^Причина сторно/), {
      target: { value: 'не той клієнт' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сторнувати' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Так, сторнувати' }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        `/payments/${PAY}/reverse`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await waitFor(() => expect(linkedFetches()).toHaveLength(2));
  });
});
