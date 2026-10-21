/**
 * Шари над карткою наряду (QA цикл 3, наживо 2026-10-21):
 * - Bug #924 — Escape у меню статусу / «Зберегти як» закриває лише меню, картка лишається;
 * - Bug #925 — меню «Зберегти як» не переживає закриття картки;
 * - Bug #926 — «Створити рахунок?» (обидві кнопки — дії): Escape — відмова від обох, без переходу.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { CreateWorkOrderModal } from '../CreateWorkOrderModal';
import { createQueryWrapper } from '@/__tests__/query-utils';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role: 'OWNER' } }),
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
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: vi.fn(),
}));

vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

const WO = '10000000-0000-4000-8000-000000000001';
const B1 = '10000000-0000-4000-8000-000000000002';
const V1 = '10000000-0000-4000-8000-000000000003';
const CP1 = '10000000-0000-4000-8000-000000000004';

type Call = [string, { method?: string; body?: string } | undefined];

function mockApi(status: string) {
  apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/branches') return Promise.resolve([{ id: B1, name: 'Філія №1' }]);
    if (path === '/warehouses') return Promise.resolve([]);
    if (path.startsWith('/employees')) return Promise.resolve({ items: [] });
    if (path.startsWith('/vehicles')) return Promise.resolve([]);
    if (path.includes('/contracts')) return Promise.resolve({ items: [] });
    if (path === '/settings/organisation') return Promise.resolve({ vatMode: 'NONE' });
    if (path === '/settings/tax-rates') return Promise.resolve([]);
    if (path.startsWith('/settings/work-hours'))
      return Promise.resolve({ workStartHour: 8, workEndHour: 18 });
    if (path === `/work-orders/${WO}/linked-documents`) {
      return Promise.resolve({ invoices: [], payments: [], calendarSlots: [], warranties: [] });
    }
    if (path === `/work-orders/${WO}/transition` && init?.method === 'POST')
      return Promise.resolve({ status: 'INVOICED' });
    if (path === `/work-orders/${WO}?withDeleted=true` || path === `/work-orders/${WO}`) {
      return Promise.resolve({
        id: WO,
        number: 'WO-001',
        status,
        branchId: B1,
        vehicleId: V1,
        counterpartyId: CP1,
        counterpartyName: 'Тест',
        contractId: null,
        liftId: null,
        description: '',
        priority: 'NORMAL',
        repairCategory: '',
        documentDate: '2026-05-20',
        plannedAt: null,
        dueDate: null,
        plannedHours: null,
        actualHours: null,
        totalAmount: 0,
        paidAmount: 0,
        lines: [],
        parts: [],
      });
    }
    return Promise.resolve({ items: [] });
  });
}

const STATUS_LABEL: Record<string, string> = { DRAFT: 'Чернетка', COMPLETED: 'Виконано' };
const INVOICE_PROMPT = 'Створити рахунок?';

const transitionCalls = () =>
  (apiFetchMock.mock.calls as Call[]).filter(([p]) => p === `/work-orders/${WO}/transition`);
const invoiceCalls = () =>
  (apiFetchMock.mock.calls as Call[]).filter(
    ([p, init]) => p.startsWith('/invoices/from-work-order') && init?.method === 'POST',
  );

/** Escape обходить слухачі document, а прапорці вкладених шарів знімаються таймером після події. */
async function pressEscape(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Escape}');
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function openCard(status: string) {
  mockApi(status);
  const onClose = vi.fn();
  const user = userEvent.setup();
  const view = render(<CreateWorkOrderModal open onClose={onClose} workOrderId={WO} />, {
    wrapper: createQueryWrapper(),
  });
  const statusButton = await screen.findByRole('button', { name: STATUS_LABEL[status] });
  return { user, onClose, view, statusButton };
}

/** Пункти меню статусу (у картці є й інші кнопки з тими самими назвами). */
const menuItem = (name: string) =>
  screen.queryAllByRole('button', { name }).find(btn => btn.className.includes('text-left'));

describe('CreateWorkOrderModal — меню над карткою й Escape (Bug #924, #925)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('Escape у відкритому меню статусу закриває лише меню', async () => {
    const { user, onClose, statusButton } = await openCard('DRAFT');
    await user.click(statusButton);
    await waitFor(() => expect(menuItem('Кошторис')).toBeTruthy());

    await pressEscape(user);

    expect(menuItem('Кошторис')).toBeUndefined();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Наряд на роботу' })).toBeTruthy();
  });

  it('Escape у меню «Зберегти як» закриває лише меню', async () => {
    const { user, onClose } = await openCard('DRAFT');
    await user.click(await screen.findByRole('button', { name: /Зберегти як/ }));
    expect(screen.getByRole('button', { name: 'Excel (.xlsx)' })).toBeTruthy();

    await pressEscape(user);

    expect(screen.queryByRole('button', { name: 'Excel (.xlsx)' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('меню «Зберегти як», відкрите при закритті картки, закрите в наступній', async () => {
    const { user, view } = await openCard('DRAFT');
    await user.click(await screen.findByRole('button', { name: /Зберегти як/ }));
    expect(screen.getByRole('button', { name: 'Excel (.xlsx)' })).toBeTruthy();

    view.rerender(<CreateWorkOrderModal open={false} onClose={vi.fn()} workOrderId={WO} />);
    view.rerender(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId={WO} />);
    await screen.findByRole('button', { name: /Зберегти як/ });

    expect(screen.queryByRole('button', { name: 'Excel (.xlsx)' })).toBeNull();
  });
});

describe('CreateWorkOrderModal — «Створити рахунок?» при переході у «Виставлено» (Bug #926)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  async function askInvoice() {
    const ctx = await openCard('COMPLETED');
    await ctx.user.click(ctx.statusButton);
    await waitFor(() => expect(menuItem('Виставити рахунок')).toBeTruthy());
    await ctx.user.click(menuItem('Виставити рахунок')!);
    await screen.findByRole('dialog', { name: INVOICE_PROMPT });
    return ctx;
  }

  it('Escape — без переходу й без рахунку, картка відкрита', async () => {
    const { user, onClose } = await askInvoice();

    await pressEscape(user);

    await waitFor(() => expect(screen.queryByRole('dialog', { name: INVOICE_PROMPT })).toBeNull());
    expect(transitionCalls()).toEqual([]);
    expect(invoiceCalls()).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('«Тільки перевести статус» — перехід у «Виставлено» без рахунку', async () => {
    const { user } = await askInvoice();

    await user.click(screen.getByRole('button', { name: 'Тільки перевести статус' }));

    await waitFor(() => expect(transitionCalls()).toHaveLength(1));
    expect(JSON.parse(transitionCalls()[0]![1]!.body!)).toEqual({ status: 'INVOICED' });
    expect(invoiceCalls()).toEqual([]);
  });
});
