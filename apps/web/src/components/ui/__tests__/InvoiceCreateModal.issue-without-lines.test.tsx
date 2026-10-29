// BR-INV-023 (рішення власника 2026-10-29): рахунок без рядків не виставляється. РАХ-2026-004310
// пішов клієнту на 100,00 без жодного рядка. Сервер відповідає 400 err.invoice.noLinesToIssue;
// картка не пропонує перехід, якого сервер не прийме: «▶» і пункт меню «Надіслати» неактивні
// (`aria-disabled`, у фокусі) з причиною в підказці, клік не шле запит. Скасування — дозволене.
//
// Мутація: прибрати `blocked={blockedTransitions}` у картці → перші два кейси червоні (POST
// transition іде); блокувати незалежно від кількості рядків → червоний третій.

import { fireEvent, render, screen, within } from '@testing-library/react';
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

const LINE = {
  id: 'line-1',
  goodId: null,
  workId: null,
  description: 'Діагностика',
  quantity: 1,
  unitPrice: 100,
  vatRate: 0,
  priceWithVat: 100,
};

const doc = (lines: (typeof LINE)[]) => ({
  id: 'inv-1',
  number: 'РАХ-0001',
  status: 'DRAFT',
  invoiceType: 'STANDARD',
  counterpartyId: 'cp-1',
  counterpartyName: 'Клієнт',
  amount: 100,
  paidAmount: 0,
  dueDate: null,
  documentDate: '2026-10-29T00:00:00.000Z',
  notes: null,
  deletedAt: null,
  workOrderId: null,
  workOrderNumber: null,
  lines,
});

const REASON = /без рядків його не можна виставити/;

function serve(lines: (typeof LINE)[]) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/invoices/inv-1?withDeleted=true') return Promise.resolve(doc(lines));
    if (path === '/invoices/inv-1/transition') return Promise.resolve({});
    return Promise.resolve({ items: [] });
  });
}

const transitionCalls = () =>
  apiFetchMock.mock.calls.filter(([path]) => path === '/invoices/inv-1/transition');

/** «▶ Надіслано» у шапці — стрілка наступного статусу. */
const nextArrow = async () => {
  const buttons = await screen.findAllByRole('button', { name: /Надіслано/ });
  return buttons[0]!;
};

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('Картка рахунку — «Виставити» без рядків (BR-INV-023)', () => {
  // guards: BR-INV-023
  it('чернетка без рядків: «▶» неактивна з причиною в підказці, клік не шле перехід', async () => {
    serve([]);
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    await screen.findByText('РАХ-0001');

    const arrow = await nextArrow();
    expect(arrow).toHaveAttribute('aria-disabled', 'true');
    expect(arrow.getAttribute('title')).toMatch(REASON);
    expect(arrow).not.toBeDisabled();

    fireEvent.click(arrow);
    expect(transitionCalls()).toHaveLength(0);
  });

  // guards: BR-INV-023
  it('меню статусу: «Надіслати» неактивний з причиною, «Скасувати» — працює', async () => {
    serve([]);
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    await screen.findByText('РАХ-0001');

    fireEvent.click(await screen.findByRole('button', { name: 'Чернетка' }));
    const send = await screen.findByRole('button', { name: 'Надіслати' });
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send.getAttribute('title')).toMatch(REASON);
    fireEvent.click(send);
    expect(transitionCalls()).toHaveLength(0);

    const menu = send.parentElement as HTMLElement;
    const cancel = within(menu)
      .getAllByRole('button')
      .find(b => b !== send) as HTMLElement;
    expect(cancel).not.toHaveAttribute('aria-disabled');
    fireEvent.click(cancel);
    await vi.waitFor(() => expect(transitionCalls()).toHaveLength(1));
    expect(transitionCalls()[0]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ status: 'CANCELLED' }),
    });
  });

  // guards: BR-INV-023
  it('чернетка зі збереженим рядком: «▶» активна, клік виставляє рахунок', async () => {
    serve([LINE]);
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    await screen.findByText('Діагностика');

    const arrow = await nextArrow();
    expect(arrow).not.toHaveAttribute('aria-disabled');
    expect(arrow.getAttribute('title') ?? '').not.toMatch(REASON);

    fireEvent.click(arrow);
    await vi.waitFor(() => expect(transitionCalls()).toHaveLength(1));
    expect(transitionCalls()[0]![1]).toMatchObject({ body: JSON.stringify({ status: 'SENT' }) });
  });
});
