// РАХ-2026-004310 (UX-огляд 2026-10-29): рахунок без рядків (створений сумою, `amount` = 100) у
// списку — 100,00 ₴, а в картці — «Рядки відсутні» і «Разом: 0.00 ₴» (крапка). Тепер картка без
// рядків показує збережену суму документа, гроші — `fmtMoney` (кома).
//
// Mutation-verify: `shownTotal = total` → падає перший кейс; повернути `.toFixed(2)` → падають обидва.

import { render, screen, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { InvoiceCreateModal } from '../InvoiceCreateModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { role: 'OWNER' } }) }));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

const base = {
  id: 'inv-1',
  number: 'РАХ-2026-004310',
  status: 'SENT',
  invoiceType: 'STANDARD',
  counterpartyId: 'cp-1',
  counterpartyName: 'Клієнт',
  paidAmount: 0,
  dueDate: null,
  documentDate: '2026-10-28T00:00:00.000Z',
  notes: null,
  deletedAt: null,
  workOrderId: null,
  workOrderNumber: null,
};
let doc: Record<string, unknown>;

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string) =>
    path === '/invoices/inv-1?withDeleted=true'
      ? Promise.resolve(doc)
      : Promise.resolve({ items: [] }),
  );
});

/** Комірка суми рядка «Разом» у підсумку таблиці рядків. */
async function totalCell() {
  const label = await screen.findByText('Разом:');
  const row = label.closest('tr') as HTMLElement;
  const cells = within(row).getAllByRole('cell');
  return cells[cells.length - 1]!;
}

describe('Картка рахунку — «Разом»', () => {
  it('без рядків — збережена сума документа, як у списку (100,00 ₴, з комою)', async () => {
    doc = { ...base, amount: 100, lines: [] };
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    await screen.findByText('РАХ-2026-004310');
    expect(await totalCell()).toHaveTextContent(/^100,00\s₴$/);
  });

  it('з рядками — сума рядків, гроші з комою', async () => {
    doc = {
      ...base,
      amount: 999,
      lines: [
        {
          id: 'l-1',
          workId: null,
          goodId: null,
          description: 'Діагностика',
          quantity: 1,
          unitPrice: 250.5,
          vatRate: 0,
          priceWithVat: 250.5,
        },
      ],
    };
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    await screen.findByText('Діагностика');
    expect(await totalCell()).toHaveTextContent(/^250,50\s₴$/);
  });
});
