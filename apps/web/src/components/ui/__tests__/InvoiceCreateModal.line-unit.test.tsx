// Bug #941 (BR-INV-021): картка рахунку показувала кількість рядка без одиниці. Рядок з наряду
// «Моторна олива — 1 Пак × 600» у картці читався як «1 × 600», тобто одна базова одиниця (літр)
// за 600 — хоча сервер віддає одиницю рядка (`unitShortName`), а друкований рахунок її показує.
//
// Мутація: без `unitShortName` у завантажених рядках картки → падає перший кейс.

import { render, screen, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { InvoiceCreateModal } from '../InvoiceCreateModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role: 'OWNER' } }),
}));

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: vi.fn(),
}));

vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

const DOC = {
  id: 'inv-1',
  number: 'РАХ-0001',
  status: 'DRAFT',
  invoiceType: 'STANDARD',
  counterpartyId: 'cp-1',
  counterpartyName: 'Клієнт',
  amount: 1100,
  paidAmount: 0,
  dueDate: null,
  documentDate: '2026-10-22T00:00:00.000Z',
  notes: null,
  deletedAt: null,
  workOrderId: 'wo-1',
  workOrderNumber: 'НРД-1',
  lines: [
    {
      id: 'line-work',
      workId: 'work-1',
      goodId: null,
      description: 'Заміна оливи',
      quantity: 1,
      unitPrice: 500,
      vatRate: 0,
      priceWithVat: 500,
    },
    {
      id: 'line-oil',
      goodId: 'good-oil',
      workId: null,
      description: 'Моторна олива 5W-40',
      unitOfMeasureId: 'uom-pak',
      unitShortName: 'Пак',
      coefficient: 10,
      quantity: 1,
      unitPrice: 600,
      vatRate: 0,
      priceWithVat: 600,
    },
  ],
};

let doc: Record<string, unknown> = DOC;

beforeEach(() => {
  doc = DOC;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/invoices/inv-1?withDeleted=true') return Promise.resolve(doc);
    return Promise.resolve({ items: [] });
  });
});

describe('Картка рахунку — одиниця рядка (BR-INV-021, Bug #941)', () => {
  // guards: BR-INV-021
  it('рядок товару в альтернативній одиниці показує кількість з одиницею рядка', async () => {
    doc = { ...DOC, status: 'SENT' };
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    const row = (await screen.findByText('Моторна олива 5W-40')).closest('tr') as HTMLElement;
    const cells = within(row).getAllByRole('cell');
    expect(cells[1]!.textContent).toBe('1Пак');
  });

  it('рядок без одиниці (робота) — лише кількість', async () => {
    doc = { ...DOC, status: 'SENT' };
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    const row = (await screen.findByText('Заміна оливи')).closest('tr') as HTMLElement;
    expect(within(row).getAllByRole('cell')[1]!.textContent).toBe('1');
  });

  // Чернетка: кількість — поле вводу (BR-INV-024), одиниця рядка лишається поруч.
  it('чернетка — поле кількості з одиницею рядка поруч', async () => {
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    const qty = await screen.findByLabelText('Кількість: Моторна олива 5W-40');
    expect(qty).toHaveValue(1);
    expect(qty.closest('td')!.textContent).toBe('Пак');
  });
});
