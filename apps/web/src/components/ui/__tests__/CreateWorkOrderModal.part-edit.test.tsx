import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { CreateWorkOrderModal } from '../CreateWorkOrderModal';

/**
 * Правка ЗБЕРЕЖЕНОГО рядка товару в картці наряду доходить до сервера (Bug #837), а залишок у
 * колонці «На складі» показується без хвоста float-арифметики (Bug #841).
 *
 * Bug #837: save() слав POST лише рядкам без `id`. Змінили кількість наявного рядка → картка
 * показувала нову кількість, «Зберегти зміни» не робило жодного запиту по товарах, у базі (і в
 * блоці «Зведення» бокової панелі списку) лишалась стара. Знайдено наживо 2026-10-13.
 *
 * Mutation-verify (2026-10-13): прибрати цикл PATCH із save() → падає кейс «кількість»;
 * прибрати `deletedPartIds.push` у PartsTable → падає кейс «склад»; повернути сире число в
 * колонці залишку → падає кейс «На складі».
 */

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// Картка бере роль користувача (друк рахунку з наряду — лише ролям, яким дозволено рахунок).
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

// Справжні UUID: save() проганяє форму через спільну zod-схему (branch / vehicle / counterparty —
// uuid), з короткими id валідація зупиняє збереження ще до запитів.
const WO = '10000000-0000-4000-8000-000000000001';
const B1 = '10000000-0000-4000-8000-000000000002';
const V1 = '10000000-0000-4000-8000-000000000003';
const CP1 = '10000000-0000-4000-8000-000000000004';
const W1 = '10000000-0000-4000-8000-000000000005';
const W2 = '10000000-0000-4000-8000-000000000006';
const G1 = '10000000-0000-4000-8000-000000000007';
const P1 = '10000000-0000-4000-8000-000000000008';

type Call = [string, { method?: string; body?: string } | undefined];

function mockApi() {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/branches') return Promise.resolve([{ id: B1, name: 'Філія №1' }]);
    if (path === '/warehouses') {
      return Promise.resolve([
        { id: W1, name: 'Склад №1' },
        { id: W2, name: 'Склад №2' },
      ]);
    }
    if (path.startsWith('/employees')) {
      return Promise.resolve({ items: [{ id: 'e1', firstName: 'Іван', lastName: 'Петров' }] });
    }
    if (path.startsWith('/vehicles')) return Promise.resolve([]);
    if (path.includes('/contracts')) return Promise.resolve({ items: [] });
    if (path === '/settings/organisation') return Promise.resolve({ vatMode: 'NONE' });
    if (path === '/settings/tax-rates') return Promise.resolve([]);
    if (path.startsWith('/goods/stock-totals')) {
      // Сума Float по рухах: саме такий хвіст стояв у dev-базі (294.96500000000003).
      return Promise.resolve([
        {
          goodId: G1,
          totalQuantity: 294.96500000000003,
          byWarehouse: [{ warehouseId: W1, quantity: 34.367000000000004 }],
        },
      ]);
    }
    if (path === `/work-orders/${WO}/linked-documents`) {
      return Promise.resolve({ invoices: [], payments: [], calendarSlots: [], warranties: [] });
    }
    if (path === `/work-orders/${WO}?withDeleted=true`) {
      return Promise.resolve({
        id: WO,
        number: 'WO-001',
        status: 'DRAFT',
        branchId: B1,
        vehicleId: V1,
        counterpartyId: CP1,
        counterpartyName: 'Тест',
        contractId: null,
        liftId: null,
        description: '',
        priority: 'NORMAL',
        repairCategory: '',
        documentDate: '2026-06-14',
        plannedAt: null,
        dueDate: null,
        plannedHours: null,
        actualHours: null,
        lines: [],
        parts: [
          {
            id: P1,
            goodId: G1,
            goodName: 'Колодки гальмівні',
            warehouseId: W1,
            quantity: 3,
            price: 50,
          },
        ],
      });
    }
    return Promise.resolve({ items: [] });
  });
}

/** Запити, що змінюють товари наряду: [метод, шлях, тіло]. */
function partWrites(): Array<[string, string, Record<string, unknown> | null]> {
  return (apiFetchMock.mock.calls as Call[])
    .filter(([path, init]) => path.includes('/parts') && !!init?.method && init.method !== 'GET')
    .map(([path, init]) => [
      init!.method!,
      path,
      init!.body ? (JSON.parse(init!.body) as Record<string, unknown>) : null,
    ]);
}

async function openAndEditPart() {
  const user = userEvent.setup();
  render(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId={WO} />);
  await screen.findByText('Колодки гальмівні');
  await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/settings/organisation'));
  await user.click(await screen.findByRole('button', { name: 'Редагувати товар' }));
  const row = screen.getByTitle('Зберегти').closest('tr')!;
  return { user, row: row as HTMLElement };
}

describe('CreateWorkOrderModal — правка збереженого рядка товару', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    mockApi();
  });

  it('змінили кількість → «Зберегти зміни» шле PATCH цьому рядку, без POST і DELETE', async () => {
    const { user, row } = await openAndEditPart();
    const qty = within(row).getByDisplayValue('3');
    await user.clear(qty);
    await user.type(qty, '4');
    await user.click(within(row).getByTitle('Зберегти'));

    await user.click(screen.getByRole('button', { name: 'Зберегти зміни' }));

    await waitFor(() => expect(partWrites()).toHaveLength(1));
    expect(partWrites()[0]).toEqual([
      'PATCH',
      `/work-orders/${WO}/parts/${P1}`,
      { quantity: 4, price: 50 },
    ]);
  });

  it('змінили склад → старий рядок видаляється, новий створюється (PATCH склад не міняє)', async () => {
    const { user, row } = await openAndEditPart();
    await user.selectOptions(within(row).getByDisplayValue('Склад №1'), W2);
    await user.click(within(row).getByTitle('Зберегти'));

    await user.click(screen.getByRole('button', { name: 'Зберегти зміни' }));

    await waitFor(() => expect(partWrites()).toHaveLength(2));
    expect(partWrites()).toEqual([
      ['DELETE', `/work-orders/${WO}/parts/${P1}`, null],
      [
        'POST',
        `/work-orders/${WO}/parts`,
        expect.objectContaining({ goodId: G1, warehouseId: W2, quantity: 3, price: 50 }),
      ],
    ]);
  });

  it('«На складі» — залишок округлено до 3 знаків, без хвоста float (294.96500000000003)', async () => {
    render(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId={WO} />);
    const name = await screen.findByText('Колодки гальмівні');
    const row = name.closest('tr')!;
    await waitFor(() => expect(row.textContent).toContain('34,367/294,965'));
    expect(row.textContent).not.toContain('0000');
  });
});
