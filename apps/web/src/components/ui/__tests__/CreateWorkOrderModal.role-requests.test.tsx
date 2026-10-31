// Картка наряду для «Бухгалтера» (клас Bug #729): бухгалтер читає наряд, але не довідники
// підйомників і авто, не залишки товарів і не календар. Картка не шле запитів, на які сервер
// відповів би 403 (`GET /lifts`, `GET /vehicles`, `GET /goods/stock-totals`,
// `POST /calendar/slots/check-conflicts`), а авто й підйомник показує з відповіді самого наряду.

import { screen, waitFor } from '@testing-library/react';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { CreateWorkOrderModal } from '../CreateWorkOrderModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiBlobFetch: vi.fn(),
}));

let role = 'ACCOUNTANT';
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

const WO = {
  id: 'wo-1',
  number: 'НЗ-2026-000001',
  status: 'APPROVED',
  branchId: 'b1',
  vehicleId: 'v1',
  vehicleSummary: 'Toyota Corolla (AA1234BB)',
  counterpartyId: 'cp1',
  counterpartyName: 'Тест',
  contractId: null,
  liftId: 'lift-1',
  liftName: 'Пост №2',
  description: '',
  priority: 'NORMAL',
  repairCategory: '',
  documentDate: '2026-10-14',
  plannedAt: '2026-10-14T07:00:00.000Z',
  dueDate: '2026-10-14T09:00:00.000Z',
  plannedHours: 2,
  actualHours: null,
  deletedAt: null,
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
  parts: [
    {
      id: 'p1',
      goodId: 'g1',
      goodName: 'Колодки',
      warehouseId: 'w1',
      quantity: 1,
      price: 900,
    },
  ],
};

function mockApi() {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/work-orders/wo-1?withDeleted=true') return Promise.resolve(WO);
    if (path === '/branches') return Promise.resolve([{ id: 'b1', name: 'Філія №1' }]);
    if (path === '/warehouses') return Promise.resolve([{ id: 'w1', name: 'Склад №1' }]);
    if (path === '/lifts') return Promise.resolve([{ id: 'lift-1', name: 'Пост №2' }]);
    if (path.startsWith('/vehicles'))
      return Promise.resolve([
        { id: 'v1', make: 'Toyota', model: 'Corolla', licensePlate: 'AA1234BB' },
      ]);
    if (path.startsWith('/employees'))
      return Promise.resolve({ items: [{ id: 'e1', firstName: 'Іван', lastName: 'Петров' }] });
    if (path === '/settings/organisation')
      return Promise.resolve({ vatMode: 'NONE', defaultVatRateId: null });
    if (path === '/settings/tax-rates') return Promise.resolve([]);
    if (path.startsWith('/goods/stock-totals')) return Promise.resolve([]);
    if (path === '/calendar/slots/check-conflicts')
      return Promise.resolve({
        liftConflict: false,
        employeeConflict: false,
        anyConflict: false,
        conflictSlots: [],
      });
    if (path.endsWith('/linked-documents'))
      return Promise.resolve({ invoices: [], payments: [], calendarSlots: [], warranties: [] });
    return Promise.resolve({ items: [] });
  });
}

const paths = () => apiFetchMock.mock.calls.map(([p]) => String(p));
const FORBIDDEN_FOR_ACCOUNTANT = (p: string) =>
  p === '/lifts' ||
  p.startsWith('/vehicles') ||
  p.startsWith('/goods/stock-totals') ||
  p === '/calendar/slots/check-conflicts';

async function open() {
  renderWithQueryClient(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId="wo-1" />);
  await screen.findByText('Заміна колодок');
  await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/settings/organisation'));
  // Перевірка зайнятості підйомника йде з затримкою (debounce 400 мс) — чекаємо довше за неї.
  await new Promise(r => setTimeout(r, 600));
}

describe('CreateWorkOrderModal — запити картки за роллю (клас Bug #729)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    mockApi();
  });

  it('«Бухгалтер»: без запитів, недоступних ролі; авто й підйомник — з наряду', async () => {
    role = 'ACCOUNTANT';
    await open();

    expect(paths().filter(FORBIDDEN_FOR_ACCOUNTANT)).toEqual([]);
    expect(
      screen.getByRole('option', { name: 'Toyota Corolla (AA1234BB)', selected: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Пост №2', selected: true })).toBeInTheDocument();
  });

  it('«Приймальня»: довідники, залишки й перевірка зайнятості — з api', async () => {
    role = 'RECEPTIONIST';
    await open();

    await waitFor(() =>
      expect(paths()).toEqual(
        expect.arrayContaining([
          '/lifts',
          '/vehicles?counterpartyId=cp1',
          '/goods/stock-totals?ids=g1',
          '/calendar/slots/check-conflicts',
        ]),
      ),
    );
  });
});
