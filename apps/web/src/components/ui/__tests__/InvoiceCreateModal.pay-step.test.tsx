// BR-INV-026 (рішення власника 2026-10-31): крок «Оплачено» в картці рахунку відкриває вікно оплати,
// як «Оплатити» у списку рахунків. Раніше він слав `POST /invoices/:id/transition {PAID}`: рахунок
// ставав «Оплачено» з дзеркальною проводкою без грошей (без каси, ПРРО, рахунку-призначення).
//
// Мутація: прибрати перехоплення `newStatus === 'PAID'` у `doTransition` → червоніють перші два
// кейси (іде transition, вікна немає); прибрати `!mayPay` з фільтра переходів → червоніє кейс ролі.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

let role = 'ACCOUNTANT';
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role } }),
}));

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: vi.fn(),
}));

vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

// Вікно оплати має власні тести (ClientPaymentModal.*); тут — що картка його відкриває для ЦЬОГО
// рахунку і що робить після оплати.
const paymentProps = vi.fn();
vi.mock('@/components/ui/ClientPaymentModal', () => ({
  ClientPaymentModal: (props: {
    open: boolean;
    title: string;
    target: unknown;
    onPaid: (amount: number, formatted: string) => void;
    onClose: () => void;
  }) => {
    paymentProps(props);
    return props.open ? (
      <div role="dialog" aria-label={props.title}>
        <button type="button" onClick={() => props.onPaid(60, '60,00 USD')}>
          Провести 60
        </button>
        <button type="button" onClick={() => props.onPaid(40, '40,00 USD')}>
          Провести 40
        </button>
      </div>
    ) : null;
  },
}));

const doc = (over: Record<string, unknown> = {}) => ({
  id: 'inv-1',
  number: 'РАХ-0026',
  status: 'SENT',
  invoiceType: 'STANDARD',
  counterpartyId: 'cp-1',
  counterpartyName: 'Клієнт',
  amount: 100,
  paidAmount: 40,
  currencyId: 'cur-usd',
  currencyCode: 'USD',
  dueDate: null,
  documentDate: '2026-10-31T00:00:00.000Z',
  notes: null,
  deletedAt: null,
  workOrderId: null,
  workOrderNumber: null,
  lines: [
    {
      id: 'line-1',
      goodId: null,
      workId: null,
      description: 'Діагностика',
      quantity: 1,
      unitPrice: 100,
      vatRate: 0,
      priceWithVat: 100,
    },
  ],
  ...over,
});

function serve(over: Record<string, unknown> = {}) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/invoices/inv-1?withDeleted=true') return Promise.resolve(doc(over));
    if (path === '/invoices/inv-1/transition') return Promise.resolve({});
    return Promise.resolve({ items: [] });
  });
}

const transitionCalls = () =>
  apiFetchMock.mock.calls.filter(([path]) => path === '/invoices/inv-1/transition');

/** «▶ Оплачено» у шапці — стрілка наступного статусу. */
const payArrow = async () => (await screen.findAllByRole('button', { name: /Оплачено/ }))[0]!;

beforeEach(() => {
  apiFetchMock.mockReset();
  paymentProps.mockReset();
  role = 'ACCOUNTANT';
});

describe('Картка рахунку — «Оплачено» відкриває вікно оплати (BR-INV-026)', () => {
  // guards: BR-INV-026
  it('«▶ Оплачено» → вікно оплати цього рахунку (сума, сплачене, платник, валюта); переходу немає', async () => {
    serve();
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    await screen.findByText('РАХ-0026');

    fireEvent.click(await payArrow());

    expect(await screen.findByRole('dialog', { name: /РАХ-0026/ })).toBeInTheDocument();
    expect(transitionCalls()).toHaveLength(0);
    expect(paymentProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: {
          kind: 'invoice',
          id: 'inv-1',
          counterpartyId: 'cp-1',
          amount: 100,
          paidAmount: 40,
          currencyCode: 'USD',
        },
      }),
    );
  });

  // guards: BR-INV-026
  it('пункт «Оплатити» меню статусу — так само вікно, не перехід', async () => {
    serve();
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    await screen.findByText('РАХ-0026');

    fireEvent.click(await screen.findByRole('button', { name: 'Надіслано' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Оплатити' }));

    expect(await screen.findByRole('dialog', { name: /РАХ-0026/ })).toBeInTheDocument();
    expect(transitionCalls()).toHaveLength(0);
  });

  // guards: BR-INV-026
  it('оплата на весь залишок → статус «Оплачено», список оновлюється (onSaved)', async () => {
    serve();
    const onSaved = vi.fn();
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} onSaved={onSaved} />);
    await screen.findByText('РАХ-0026');

    fireEvent.click(await payArrow());
    fireEvent.click(await screen.findByRole('button', { name: 'Провести 60' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /РАХ-0026/ })).not.toBeInTheDocument(),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('Оплачено').length).toBeGreaterThan(0);
    expect(transitionCalls()).toHaveLength(0);
  });

  // guards: BR-INV-026
  it('часткова оплата → «Частково оплачено», наступне вікно бачить нове сплачене', async () => {
    serve({ paidAmount: 0 });
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    await screen.findByText('РАХ-0026');

    fireEvent.click(await payArrow());
    fireEvent.click(await screen.findByRole('button', { name: 'Провести 40' }));

    expect(await screen.findByText('Частково оплачено')).toBeInTheDocument();
    fireEvent.click(await payArrow());
    await screen.findByRole('dialog', { name: /РАХ-0026/ });
    expect(paymentProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ paidAmount: 40 }) }),
    );
  });

  // guards: BR-INV-026, BR-INV-019
  it('рахунок наряду → кроку «Оплачено» немає (закривається оплатою наряду)', async () => {
    serve({ workOrderId: 'wo-1', workOrderNumber: 'НЗ-1' });
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    await screen.findByText('РАХ-0026');
    await screen.findByRole('button', { name: 'Надіслано' });

    expect(screen.queryByRole('button', { name: /Оплачено/ })).toBeNull();
  });

  // guards: BR-INV-026
  it('роль без права реєструвати оплату → кроку «Оплачено» немає', async () => {
    role = 'MECHANIC';
    serve();
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    await screen.findByText('РАХ-0026');
    await screen.findByRole('button', { name: 'Надіслано' });

    expect(screen.queryByRole('button', { name: /Оплачено/ })).toBeNull();
  });
});
