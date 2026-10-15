// Картка наряду — «Оплатити» з документа наряду (рішення власника 2026-10-15).
//
// - кнопка є в статусах, що приймають оплату (`WO_PAYABLE_STATUSES`), і лише ролям, яким сервер
//   дозволяє POST /payments (`PAYMENT_CREATE_ROLES`); «Механік» її не бачить;
// - до «Виконано» вікно — «Аванс за нарядом», після — «Оплата наряду» (BR-PAY-020);
// - ручного переходу «Оплачено» в меню статусу немає (BR-WO-016);
// - після оплати картка перечитує наряд: статус береться з сервера («Оплачено»);
// - Escape у вікні оплати закриває лише його, картка лишається відкритою.

import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { WO_PAYABLE_STATUSES } from '@sto/shared';
import { CreateWorkOrderModal } from '../CreateWorkOrderModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiBlobFetch: vi.fn(),
}));

let role = 'OWNER';
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role } }),
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

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: vi.fn(),
}));

vi.mock('@/hooks/api/useCash', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/useCash')>();
  return {
    ...actual,
    useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
    useCashRegisters: () => ({ data: [], isPending: false, isError: false }),
  };
});

let woStatus = 'IN_PROGRESS';
let paid = 0;

function woDoc() {
  return {
    id: 'wo-1',
    number: 'НЗ-2026-000001',
    status: woStatus,
    branchId: 'b1',
    vehicleId: 'v1',
    counterpartyId: 'cp1',
    counterpartyName: 'Тест',
    contractId: null,
    liftId: null,
    description: '',
    priority: 'NORMAL',
    repairCategory: '',
    documentDate: '2026-10-14',
    plannedAt: null,
    dueDate: null,
    plannedHours: 2,
    actualHours: null,
    deletedAt: null,
    totalAmount: 1000,
    paidAmount: paid,
    currencyCode: null,
    lines: [
      {
        id: 'l1',
        workId: 'work-1',
        workName: 'Заміна колодок',
        employeeId: 'e1',
        normoHours: 2,
        actualHours: null,
        price: 500,
      },
    ],
    parts: [],
  };
}

function mockApi() {
  apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/work-orders/wo-1?withDeleted=true' || path === '/work-orders/wo-1')
      return Promise.resolve(woDoc());
    if (path === '/payment-methods')
      return Promise.resolve([
        { code: 'card_terminal', name: 'Термінал', isActive: true, defaultSourceType: null },
      ]);
    if (path === '/payments' && init?.method === 'POST') {
      // Повна оплата наряду «Виставлено» → сервер переводить його в «Оплачено» (BR-PAY-005).
      paid = 1000;
      woStatus = 'PAID';
      return Promise.resolve({ id: 'pay-1' });
    }
    if (path === '/invoices/from-work-order/wo-1/find') return Promise.resolve(null);
    if (path === '/branches') return Promise.resolve([{ id: 'b1', name: 'Філія №1' }]);
    if (path === '/warehouses') return Promise.resolve([{ id: 'w1', name: 'Склад №1' }]);
    if (path.startsWith('/employees')) {
      return Promise.resolve({ items: [{ id: 'e1', firstName: 'Іван', lastName: 'Петров' }] });
    }
    if (path.startsWith('/vehicles')) return Promise.resolve([]);
    if (path === '/settings/organisation') {
      return Promise.resolve({ vatMode: 'NONE', defaultVatRateId: null });
    }
    if (path === '/settings/tax-rates') return Promise.resolve([]);
    if (path.endsWith('/linked-documents')) {
      return Promise.resolve({ invoices: [], payments: [], calendarSlots: [], warranties: [] });
    }
    return Promise.resolve({ items: [] });
  });
}

const payButton = () => screen.queryByRole('button', { name: /^Оплатити$/ });

async function open(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CreateWorkOrderModal open onClose={onClose} workOrderId="wo-1" />
    </QueryClientProvider>,
  );
  await screen.findByText('Заміна колодок');
  return onClose;
}

describe('CreateWorkOrderModal — «Оплатити» з наряду', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    role = 'OWNER';
    woStatus = 'IN_PROGRESS';
    paid = 0;
    mockApi();
  });

  // guards: BR-PAY-001
  it.each(WO_PAYABLE_STATUSES.map(s => [s]))('статус %s → кнопка «Оплатити» є', async status => {
    woStatus = status;
    await open();
    await waitFor(() => expect(payButton()).toBeInTheDocument());
  });

  // guards: BR-PAY-001
  it.each([['PAID'], ['ARCHIVED'], ['CANCELLED']])(
    'статус %s → кнопки «Оплатити» немає',
    async status => {
      woStatus = status;
      await open();
      expect(payButton()).not.toBeInTheDocument();
    },
  );

  // guards: BR-PAY-001
  it('роль «Механік» (сервер не дозволяє POST /payments) → кнопки немає', async () => {
    role = 'MECHANIC';
    await open();
    expect(payButton()).not.toBeInTheDocument();
  });

  // guards: BR-WO-016
  it('меню статусу «Виставлено» не має ручного переходу «Оплачено»', async () => {
    woStatus = 'INVOICED';
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Виставлено' }));
    expect(screen.queryByRole('button', { name: 'Оплачено' })).not.toBeInTheDocument();
  });

  // guards: BR-PAY-020
  it('до «Виконано» — «Аванс за нарядом», після — «Оплата наряду»', async () => {
    await open();
    await userEvent.click(payButton()!);
    expect(
      await screen.findByRole('dialog', { name: 'Аванс за нарядом НЗ-2026-000001' }),
    ).toBeInTheDocument();
  });

  // guards: BR-PAY-005, BR-WO-016
  it('оплата залишку «Виставлено» → картка перечитує наряд і показує «Оплачено» з сервера', async () => {
    woStatus = 'INVOICED';
    await open();
    await userEvent.click(payButton()!);
    const dialog = await screen.findByRole('dialog', { name: 'Оплата наряду НЗ-2026-000001' });
    await within(dialog).findByRole('option', { name: 'Термінал' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Підтвердити оплату' }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/payments',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const body = JSON.parse(
      (apiFetchMock.mock.calls.find(([p]) => p === '/payments')![1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ workOrderId: 'wo-1', counterpartyId: 'cp1', amount: 1000 });
    // Статус — з повторного читання наряду, а не «натиснутої кнопки».
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/work-orders/wo-1'));
    expect(await screen.findByRole('button', { name: 'Оплачено' })).toBeInTheDocument();
    expect(payButton()).not.toBeInTheDocument();
  });

  it('Escape у вікні оплати закриває лише його — картка лишається', async () => {
    const onClose = await open();
    await userEvent.click(payButton()!);
    await screen.findByRole('dialog', { name: 'Аванс за нарядом НЗ-2026-000001' });

    await userEvent.keyboard('{Escape}');

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Аванс за нарядом НЗ-2026-000001' }),
      ).not.toBeInTheDocument(),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
