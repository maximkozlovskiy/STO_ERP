// Список кас показує валюту кожної каси окремою колонкою (запит власника 2026-10-22): касу в
// доларах не сплутати з гривневою за самим числом залишку.
import { render, screen, within } from '@testing-library/react';
import { vi, it, expect, describe } from 'vitest';
import CashRegistersTab from '../CashRegistersTab';

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve([])),
}));
vi.mock('@/hooks/api/useCash', () => ({
  useCashRegisters: () => ({
    isLoading: false,
    data: [
      {
        id: 'r1',
        name: 'Каса USD',
        branchName: 'Головна філія',
        isFiscal: false,
        balance: 0,
        currencyId: 'c1',
        currencyCode: 'USD',
        currencySymbol: '$',
      },
      {
        id: 'r2',
        name: 'Каса без символу',
        branchName: 'Головна філія',
        isFiscal: false,
        balance: 10,
        currencyId: 'c2',
        currencyCode: 'PLN',
        currencySymbol: null,
      },
    ],
  }),
  useCreateCashRegister: () => ({ mutateAsync: vi.fn() }),
  useUpdateCashRegister: () => ({ mutateAsync: vi.fn() }),
  useDeleteCashRegister: () => ({ mutateAsync: vi.fn() }),
}));

describe('CashRegistersTab — колонка «Валюта»', () => {
  it('заголовок «Валюта» і код валюти (із символом) у рядку кожної каси', () => {
    render(<CashRegistersTab />);
    expect(screen.getByRole('columnheader', { name: 'Валюта' })).toBeInTheDocument();
    const usd = screen.getByRole('row', { name: /Каса USD/ });
    const cells = within(usd).getAllByRole('cell');
    expect(cells[3]).toHaveTextContent('USD · $');
    const pln = screen.getByRole('row', { name: /Каса без символу/ });
    expect(within(pln).getAllByRole('cell')[3]).toHaveTextContent(/^PLN$/);
  });
});
