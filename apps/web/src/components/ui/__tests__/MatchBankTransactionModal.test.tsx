// Regression-guard для MatchBankTransactionModal — submit рознесення викликає
// POST /bank-statements/transactions/:id/match з правильним counterpartyId + type.

import { screen, waitFor, fireEvent, within } from '@testing-library/react';
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

const CP_UUID = '22222222-2222-4222-8222-222222222222';

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
  source: 'FILE_IMPORT',
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

  // Bug #861: Escape у пікері закривав і саме вікно рознесення (docs/GOTCHAS.md 2026-10-12).
  // Mutation-verify: прибрати `if (pickerOpenRef.current) return;` у close → кейс падає.
  it('Escape у пікері контрагента закриває лише пікер, вікно лишається', async () => {
    apiFetchMock.mockResolvedValue({ items: [] });
    const onClose = vi.fn();
    renderWithQueryClient(<MatchBankTransactionModal open onClose={onClose} transaction={TX} />);
    fireEvent.click(screen.getByRole('button', { name: 'Обрати' }));
    expect(await screen.findByRole('dialog', { name: 'Оберіть контрагента' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Оберіть контрагента' })).not.toBeInTheDocument(),
    );
    expect(onClose).not.toHaveBeenCalled();
    // Пікер закрито — тепер Escape закриває вже саме вікно.
    await new Promise(r => setTimeout(r, 0));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Bug #864: рядок пікера рахунку показував «₴» біля суми рахунку в будь-якій валюті.
  // Mutation-verify: повернути `${fmtMoney(inv.amount)} ₴` → кейс падає.
  it('пікер рахунку: сума рахунку з його валютою', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path.startsWith('/invoices?'))
        return Promise.resolve({
          items: [
            { id: 'inv-usd', number: 'INV-USD', amount: 77, paidAmount: 0, currencyCode: 'USD' },
            { id: 'inv-uah', number: 'INV-UAH', amount: 300, paidAmount: 0, currencyCode: 'UAH' },
          ],
        });
      return Promise.resolve({ items: [] });
    });
    renderWithQueryClient(
      <MatchBankTransactionModal
        open
        onClose={() => {}}
        transaction={TX}
        suggestedCounterpartyId={CP_UUID}
        suggestedCounterpartyName="ТОВ Клієнт"
        suggestedMatchType="INVOICE"
      />,
    );
    const pickers = screen.getAllByRole('button', { name: 'Обрати' });
    fireEvent.click(pickers[pickers.length - 1]);
    const picker = await screen.findByRole('dialog', { name: 'Оберіть рахунок' });
    expect(await within(picker).findByText(/^77,00\sUSD$/)).toBeInTheDocument();
    expect(within(picker).getByText(/^300,00\s₴$/)).toBeInTheDocument();
  });
});
