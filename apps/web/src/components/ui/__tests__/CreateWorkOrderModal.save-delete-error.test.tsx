import { screen, waitFor } from '@testing-library/react';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { CreateWorkOrderModal } from '../CreateWorkOrderModal';

/**
 * Bug #869: «Зберегти зміни» картки наряду видаляє рядки паралельно (`Promise.allSettled`) і
 * результатів не дивився — відмова сервера на DELETE рядка губилась, список «видалених» очищався,
 * а картка закривалась. Наживо: наряд з авансом 1100, єдиний рядок на 2400 → видалити рядок →
 * «Зберегти зміни» → сервер 400 «Сума наряду … стала б меншою за сплачене … — спершу сторнуйте
 * оплату» (BR-WO-015), а користувач бачив закриту картку без жодного повідомлення; рядок лишився.
 *
 * Очікування: помилка сервера — у картці, картка відкрита, рядок лишається серед «видалених»,
 * тож повторне «Зберегти» шле той самий DELETE ще раз.
 */

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
const L1 = '10000000-0000-4000-8000-000000000005';
const WK1 = '10000000-0000-4000-8000-000000000006';
const E1 = '10000000-0000-4000-8000-000000000007';
const LINE_URL = `/work-orders/${WO}/lines/${L1}`;

const BELOW_PAID = 'Сума наряду 0.00 стала б меншою за сплачене 1100.00 — спершу сторнуйте оплату';

function mockApi(deleteLine: () => Promise<unknown>) {
  apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
    if (init?.method === 'DELETE' && path === LINE_URL) return deleteLine();
    if (init?.method === 'PATCH' && path === `/work-orders/${WO}`) return Promise.resolve({});
    if (path === '/branches') return Promise.resolve([{ id: B1, name: 'Філія №1' }]);
    if (path === '/warehouses') return Promise.resolve([{ id: 'w1', name: 'Склад №1' }]);
    if (path.startsWith('/employees')) {
      return Promise.resolve({ items: [{ id: E1, firstName: 'Іван', lastName: 'Петров' }] });
    }
    if (path.startsWith('/vehicles')) return Promise.resolve([]);
    if (path.includes('/contracts')) return Promise.resolve({ items: [] });
    if (path === '/settings/organisation') return Promise.resolve({ vatMode: 'NONE' });
    if (path === '/settings/tax-rates') return Promise.resolve([]);
    if (path === `/work-orders/${WO}/linked-documents`) {
      return Promise.resolve({ invoices: [], payments: [], calendarSlots: [], warranties: [] });
    }
    if (path === `/work-orders/${WO}?withDeleted=true`) {
      return Promise.resolve({
        id: WO,
        number: 'WO-001',
        status: 'APPROVED',
        branchId: B1,
        vehicleId: V1,
        counterpartyId: CP1,
        counterpartyName: 'Тест',
        contractId: null,
        liftId: null,
        description: '',
        priority: 'NORMAL',
        repairCategory: '',
        documentDate: '2026-10-15',
        plannedAt: null,
        dueDate: null,
        plannedHours: null,
        actualHours: null,
        totalAmount: 2400,
        paidAmount: 1100,
        lines: [
          {
            id: L1,
            workId: WK1,
            workName: 'Заміна колодок',
            employeeId: E1,
            normoHours: 1,
            actualHours: null,
            price: 2000,
          },
        ],
        parts: [],
      });
    }
    return Promise.resolve({ items: [] });
  });
}

const deleteCalls = () =>
  apiFetchMock.mock.calls.filter(
    ([path, init]) => path === LINE_URL && (init as { method?: string })?.method === 'DELETE',
  ).length;

describe('CreateWorkOrderModal — збереження, коли сервер відхилив видалення рядка (Bug #869)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  // guards: BR-WO-015
  it('помилка DELETE рядка — у картці, картка не закривається, повтор шле DELETE знову', async () => {
    mockApi(() => Promise.reject(new Error(BELOW_PAID)));
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithQueryClient(<CreateWorkOrderModal open onClose={onClose} workOrderId={WO} />);
    await screen.findByText('Заміна колодок');
    await user.click((await screen.findAllByRole('button', { name: 'Видалити роботу' }))[0]!);

    await user.click(screen.getByRole('button', { name: 'Зберегти зміни' }));

    expect(await screen.findByText(BELOW_PAID)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(deleteCalls()).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
    await waitFor(() => expect(deleteCalls()).toBe(2));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('DELETE рядка пройшов — картка закривається як раніше', async () => {
    mockApi(() => Promise.resolve(undefined));
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithQueryClient(<CreateWorkOrderModal open onClose={onClose} workOrderId={WO} />);
    await screen.findByText('Заміна колодок');
    await user.click((await screen.findAllByRole('button', { name: 'Видалити роботу' }))[0]!);

    await user.click(screen.getByRole('button', { name: 'Зберегти зміни' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(deleteCalls()).toBe(1);
  });
});
