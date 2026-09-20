// Regression-guard для MatchBankTransactionModal — submit рознесення викликає
// POST /bank-statements/transactions/:id/match з правильним counterpartyId + type.

import { screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { MatchBankTransactionModal } from '../MatchBankTransactionModal';
import { renderWithQueryClient } from '../../../__tests__/query-utils';
import type { BankTransaction } from '@/hooks/api/useBankStatements';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiMultipartFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const CP_UUID = '22222222-2222-2222-2222-222222222222';

const TX: BankTransaction = {
  id: 'tx-1',
  orgId: 'org-1',
  bankAccountId: 'ba-1',
  direction: 'IN',
  amount: 1500,
  currencyId: 'UAH',
  operationDate: '2026-09-01T00:00:00.000Z',
  payerName: 'ТОВ Клієнт',
  purpose: 'Оплата за послуги',
  externalId: 'ext-1',
  source: 'IMPORT',
  status: 'UNMATCHED',
  createdAt: '2026-09-01T00:00:00.000Z',
};

describe('MatchBankTransactionModal', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('prefill з підказки: контрагент показаний, submit шле match з type=PREPAYMENT', async () => {
    apiFetchMock.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path.includes('/match') && opts?.method === 'POST')
        return Promise.resolve({ ...TX, status: 'MATCHED' });
      return Promise.resolve({ items: [] });
    });

    const onMatched = vi.fn();
    renderWithQueryClient(
      <MatchBankTransactionModal
        open
        onClose={() => {}}
        transaction={TX}
        suggestedCounterpartyId={CP_UUID}
        suggestedCounterpartyName="ТОВ Клієнт"
        onMatched={onMatched}
      />,
    );

    // Кнопка активна одразу (prefill дав counterpartyId).
    const submitBtn = screen.getByRole('button', { name: 'Рознести' }) as HTMLButtonElement;
    await waitFor(() => expect(submitBtn.disabled).toBe(false));

    fireEvent.click(submitBtn);

    await waitFor(() => {
      const matchCall = apiFetchMock.mock.calls.find(
        c => typeof c[0] === 'string' && (c[0] as string).includes('/match'),
      );
      expect(matchCall).toBeTruthy();
      const body = JSON.parse((matchCall![1] as { body: string }).body);
      expect(body).toEqual({ counterpartyId: CP_UUID, type: 'PREPAYMENT', invoiceId: undefined });
    });
    await waitFor(() => expect(onMatched).toHaveBeenCalled());
  });

  it('без контрагента submit заблокований', () => {
    apiFetchMock.mockResolvedValue({ items: [] });
    renderWithQueryClient(<MatchBankTransactionModal open onClose={() => {}} transaction={TX} />);
    const submitBtn = screen.getByRole('button', { name: 'Рознести' }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  it('type=INVOICE без рахунку показує помилку і не шле match', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path.includes('/match')) return Promise.resolve({ ...TX, status: 'MATCHED' });
      return Promise.resolve({ items: [] });
    });

    renderWithQueryClient(
      <MatchBankTransactionModal
        open
        onClose={() => {}}
        transaction={TX}
        suggestedCounterpartyId={CP_UUID}
        suggestedCounterpartyName="ТОВ Клієнт"
      />,
    );

    // Змінюємо тип на INVOICE.
    const typeSelect = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'INVOICE' } });

    const submitBtn = screen.getByRole('button', { name: 'Рознести' }) as HTMLButtonElement;
    fireEvent.click(submitBtn);

    // match НЕ викликаний (invoiceId відсутній).
    await waitFor(() => {
      const matchCall = apiFetchMock.mock.calls.find(
        c => typeof c[0] === 'string' && (c[0] as string).includes('/match'),
      );
      expect(matchCall).toBeFalsy();
    });
  });
});
