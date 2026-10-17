// Картка наряду — друк наряд-замовлення і рахунку з наряду (BR-WO-013).
//
// - від «Виконано» («Виконано», «Виставлено», «Оплачено», «Архів») — «Друк наряду» і «Зберегти PDF»
//   (серверний PDF з реквізитами); до того — друк кошторису, як раніше; у «В роботі» — нічого;
// - наряд позначено на видалення (BR-WO-012) — серверного друку немає;
// - «Друк рахунку» — лише коли рахунок наряду є і роль може його друкувати; ролі без доступу до
//   рахунку («Механік») рахунок навіть не запитують;
// - друк відкриває вікно ДО запиту PDF; запит упав → вікно закривається, помилка показується.

import { screen, waitFor } from '@testing-library/react';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';
import { CreateWorkOrderModal } from '../CreateWorkOrderModal';
import { toast } from '@/lib/toast';

const apiFetchMock = vi.fn();
const apiBlobFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiBlobFetch: (...args: unknown[]) => apiBlobFetchMock(...args),
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

vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

const INVOICE = { id: 'inv-1', number: 'РАХ-2026-000001' };

function woDoc(status: string, deletedAt: string | null = null) {
  return {
    id: 'wo-1',
    number: 'НЗ-2026-000001',
    status,
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
    deletedAt,
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

function mockApi(status: string, opts: { deletedAt?: string | null; invoice?: unknown } = {}) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/work-orders/wo-1?withDeleted=true')
      return Promise.resolve(woDoc(status, opts.deletedAt ?? null));
    if (path === '/invoices/from-work-order/wo-1/find')
      return Promise.resolve(opts.invoice === undefined ? INVOICE : opts.invoice);
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

const findCalls = () =>
  apiFetchMock.mock.calls.filter(([p]) => p === '/invoices/from-work-order/wo-1/find');
const button = (name: string | RegExp) => screen.queryByRole('button', { name });

async function open() {
  renderWithQueryClient(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId="wo-1" />);
  await screen.findByText('Заміна колодок');
  await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/settings/organisation'));
}

describe('CreateWorkOrderModal — друк наряд-замовлення (BR-WO-013)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiBlobFetchMock.mockReset();
    role = 'OWNER';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // guards: BR-WO-013
  it.each(['COMPLETED', 'INVOICED', 'PAID', 'ARCHIVED'])(
    '%s → «Друк наряду» і «Зберегти PDF», без друку кошторису',
    async status => {
      mockApi(status);
      await open();

      expect(button(/Друк наряду/)).toBeInTheDocument();
      expect(button(/Зберегти PDF/)).toBeInTheDocument();
      expect(button('Друк')).not.toBeInTheDocument();
      expect(button(/Зберегти як/)).not.toBeInTheDocument();
    },
  );

  // guards: BR-WO-013
  it.each(['DRAFT', 'ESTIMATE', 'APPROVED'])(
    '%s → друк кошторису як раніше, наряд-замовлення немає',
    async status => {
      mockApi(status);
      await open();

      expect(button('Друк')).toBeInTheDocument();
      expect(button(/Друк наряду/)).not.toBeInTheDocument();
      expect(button(/Зберегти PDF/)).not.toBeInTheDocument();
      expect(button(/Друк рахунку/)).not.toBeInTheDocument();
      expect(findCalls()).toHaveLength(0);
    },
  );

  // guards: BR-WO-013
  it.each(['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'])(
    '%s → ні кошторису, ні наряд-замовлення',
    async status => {
      mockApi(status);
      await open();

      expect(button('Друк')).not.toBeInTheDocument();
      expect(button(/Друк наряду/)).not.toBeInTheDocument();
      expect(button(/Зберегти PDF/)).not.toBeInTheDocument();
    },
  );

  // guards: BR-WO-013
  it('видалений наряд у «Виконано» → серверного друку немає, рахунок не запитується (BR-WO-012)', async () => {
    mockApi('COMPLETED', { deletedAt: '2026-10-13T09:00:00.000Z' });
    await open();

    expect(screen.getByTestId('deleted-document-banner')).toBeInTheDocument();
    expect(button(/Друк наряду/)).not.toBeInTheDocument();
    expect(button(/Зберегти PDF/)).not.toBeInTheDocument();
    expect(button(/Друк рахунку/)).not.toBeInTheDocument();
    expect(findCalls()).toHaveLength(0);
  });
});

describe('CreateWorkOrderModal — «Друк рахунку» з наряду', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiBlobFetchMock.mockReset();
    role = 'OWNER';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('рахунок наряду є → кнопка є', async () => {
    mockApi('INVOICED');
    await open();

    expect(await screen.findByRole('button', { name: /Друк рахунку/ })).toBeInTheDocument();
  });

  it('рахунку немає (/find → null) → кнопки немає', async () => {
    mockApi('COMPLETED', { invoice: null });
    await open();

    await waitFor(() => expect(findCalls()).toHaveLength(1));
    expect(button(/Друк рахунку/)).not.toBeInTheDocument();
  });

  it.each(['ACCOUNTANT', 'RECEPTIONIST', 'ADMIN'])('%s бачить «Друк рахунку»', async r => {
    role = r;
    mockApi('PAID');
    await open();

    expect(await screen.findByRole('button', { name: /Друк рахунку/ })).toBeInTheDocument();
  });

  it('«Механік» друкує наряд-замовлення, але рахунок не запитується і кнопки немає', async () => {
    role = 'MECHANIC';
    mockApi('INVOICED');
    await open();

    expect(button(/Друк наряду/)).toBeInTheDocument();
    expect(findCalls()).toHaveLength(0);
    expect(button(/Друк рахунку/)).not.toBeInTheDocument();
  });

  it('«Друк рахунку» відкриває вікно і запитує PDF саме цього рахунку', async () => {
    const win = {
      document: document.implementation.createHTMLDocument(''),
      closed: false,
      close: vi.fn(),
      addEventListener: vi.fn(),
    };
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:x', configurable: true });
    apiBlobFetchMock.mockResolvedValue(new Blob(['%PDF'], { type: 'application/pdf' }));
    mockApi('INVOICED');
    await open();

    await userEvent.click(await screen.findByRole('button', { name: /Друк рахунку/ }));

    await waitFor(() => expect(apiBlobFetchMock).toHaveBeenCalledWith('/invoices/inv-1/pdf'));
    expect(window.open).toHaveBeenCalledWith('', '_blank');
  });
});

describe('CreateWorkOrderModal — «Друк наряду»: вікно до запиту, закриття при помилці', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiBlobFetchMock.mockReset();
    role = 'OWNER';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // guards: BR-WO-013
  it('вікно відкривається ДО запиту PDF наряду; сервер відмовив → вікно закрито, текст помилки показано', async () => {
    const order: string[] = [];
    const win = {
      document: document.implementation.createHTMLDocument(''),
      closed: false,
      close: vi.fn(),
      addEventListener: vi.fn(),
    };
    vi.spyOn(window, 'open').mockImplementation(() => {
      order.push('open');
      return win as unknown as Window;
    });
    apiBlobFetchMock.mockImplementation((path: string) => {
      order.push(path);
      return Promise.reject(new Error('Наряд-замовлення друкується після виконання робіт'));
    });
    const toastError = vi.spyOn(toast, 'error').mockImplementation(() => undefined as never);
    mockApi('COMPLETED', { invoice: null });
    await open();

    await userEvent.click(screen.getByRole('button', { name: /Друк наряду/ }));

    await waitFor(() => expect(win.close).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['open', '/work-orders/wo-1/pdf']);
    expect(toastError).toHaveBeenCalledWith('Наряд-замовлення друкується після виконання робіт');
  });

  it('«Зберегти PDF» завантажує PDF наряду без відкриття вікна', async () => {
    const openSpy = vi.spyOn(window, 'open');
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:x', configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    apiBlobFetchMock.mockResolvedValue(new Blob(['%PDF'], { type: 'application/pdf' }));
    mockApi('ARCHIVED', { invoice: null });
    await open();

    await userEvent.click(screen.getByRole('button', { name: /Зберегти PDF/ }));

    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(apiBlobFetchMock).toHaveBeenCalledWith('/work-orders/wo-1/pdf');
    expect(openSpy).not.toHaveBeenCalled();
  });
});
