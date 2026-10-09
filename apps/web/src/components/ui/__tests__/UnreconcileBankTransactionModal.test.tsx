// Скасування рознесення банківського платежу (BR-BANK-039):
//   - причина обов'язкова; пробіли — не причина;
//   - payload `{ reason }` — обрізаний, на POST …/:id/unreconcile;
//   - наслідок показано ДО відправки й залежить від виду рознесення;
//   - відмова сервера лишається в модалці його текстом.
//
// Mutation-verify:
//   - `disabled={!canSubmit}` → `disabled={mut.isPending}`      → «без причини» і «пробіли» падають;
//   - `reason: parsed.data.reason` → `reason`                   → «payload обрізаний» падає;
//   - `consequence.${matchedType}` → `consequence.EXPENSE`      → кейси наслідку падають.

import { screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { UnreconcileBankTransactionModal } from '../UnreconcileBankTransactionModal';
import { renderWithQueryClient } from '../../../__tests__/query-utils';
import type { BankTransaction } from '@/hooks/api/useBankStatements';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiMultipartFetch: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

const TX: BankTransaction = {
  id: 'tx-9',
  orgId: 'org-1',
  bankAccountId: 'ba-1',
  direction: 'OUT',
  amount: 1200,
  currencyId: 'cur-uah',
  operationDate: '2026-10-01',
  payerName: 'ТОВ Постачальник',
  purpose: 'Оплата',
  externalId: 'ext-9',
  source: 'FILE_IMPORT',
  status: 'MATCHED',
  matchedType: 'SUPPLIER_PAYMENT',
  createdAt: '2026-10-01T00:00:00.000Z',
};

const submitBtn = () =>
  screen.getByRole('button', { name: 'Зняти рознесення' }) as HTMLButtonElement;
const reasonField = () => screen.getByLabelText(/Причина/) as HTMLTextAreaElement;
const unreconcileCalls = () =>
  apiFetchMock.mock.calls.filter(c => String(c[0]).includes('/unreconcile'));

describe('UnreconcileBankTransactionModal', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  it('без причини кнопка вимкнена', () => {
    renderWithQueryClient(
      <UnreconcileBankTransactionModal open onClose={() => {}} transaction={TX} />,
    );
    expect(reasonField().value).toBe('');
    expect(submitBtn().disabled).toBe(true);
  });

  it('пробіли — не причина: кнопка лишається вимкненою, запит не йде', () => {
    renderWithQueryClient(
      <UnreconcileBankTransactionModal open onClose={() => {}} transaction={TX} />,
    );
    fireEvent.change(reasonField(), { target: { value: '   \n\t ' } });
    expect(submitBtn().disabled).toBe(true);
    fireEvent.click(submitBtn());
    expect(unreconcileCalls()).toHaveLength(0);
  });

  it('з причиною: POST …/:id/unreconcile з обрізаною причиною; модалка закривається', async () => {
    apiFetchMock.mockResolvedValue({ ...TX, status: 'UNMATCHED' });
    const onClose = vi.fn();
    const onDone = vi.fn();
    renderWithQueryClient(
      <UnreconcileBankTransactionModal open onClose={onClose} onDone={onDone} transaction={TX} />,
    );
    fireEvent.change(reasonField(), { target: { value: '  помилковий постачальник  ' } });
    expect(submitBtn().disabled).toBe(false);
    fireEvent.click(submitBtn());

    await waitFor(() => expect(unreconcileCalls()).toHaveLength(1));
    const [path, init] = unreconcileCalls()[0] as [string, { method: string; body: string }];
    expect(path).toBe('/bank-statements/transactions/tx-9/unreconcile');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ reason: 'помилковий постачальник' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDone).toHaveBeenCalled();
    expect(toastMock.success).toHaveBeenCalledWith('Рознесення знято');
  });

  it('ліміт причини — 500 символів, лічильник показує довжину', () => {
    renderWithQueryClient(
      <UnreconcileBankTransactionModal open onClose={() => {}} transaction={TX} />,
    );
    expect(reasonField()).toHaveAttribute('maxlength', '500');
    expect(screen.getByText('0 / 500')).toBeInTheDocument();
    fireEvent.change(reasonField(), { target: { value: 'дубль' } });
    expect(screen.getByText('5 / 500')).toBeInTheDocument();
  });

  it.each([
    ['SUPPLIER_PAYMENT', /оплата постачальнику лишиться проведеною, рядок стане вільним/i],
    ['CLIENT_REFUND', /буде зроблено зворотне проведення/i],
    ['CASH_WITHDRAWAL', /з каси буде списано ту саму суму/i],
    ['EXPENSE', /лише класифікацію платежу/i],
    ['PAYROLL', /стан зарплатного періоду не зміниться/i],
    ['TRANSFER', /лише позначку переказу/i],
  ] as const)('наслідок для %s показано до відправки', (matchedType, text) => {
    renderWithQueryClient(
      <UnreconcileBankTransactionModal
        open
        onClose={() => {}}
        transaction={{ ...TX, matchedType }}
      />,
    );
    expect(screen.getByRole('note')).toHaveTextContent(text);
  });

  it('відмова сервера лишається в модалці його текстом; модалка не закривається', async () => {
    apiFetchMock.mockRejectedValue(new Error('У касі недостатньо готівки'));
    const onClose = vi.fn();
    renderWithQueryClient(
      <UnreconcileBankTransactionModal open onClose={onClose} transaction={TX} />,
    );
    fireEvent.change(reasonField(), { target: { value: 'дубль' } });
    fireEvent.click(submitBtn());
    expect(await screen.findByRole('alert')).toHaveTextContent('У касі недостатньо готівки');
    expect(onClose).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
