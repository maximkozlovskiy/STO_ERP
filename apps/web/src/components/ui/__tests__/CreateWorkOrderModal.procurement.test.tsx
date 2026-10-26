import { screen, waitFor, within } from '@testing-library/react';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { CreateWorkOrderModal } from '../CreateWorkOrderModal';

/**
 * Картка наряду й закупівля (docs/objects/purchase-list.md): біля залишку збереженого рядка —
 * стан позицій списків купівлі й нестача (`GET /purchase-list-items/by-work-order/:id`), дія
 * «До списку купівлі» — ролям, що надсилають (BR-PL-015), з кількістю = нестача (BR-PL-003).
 *
 * Mutation-verify: прибрати `<ProcurementBadge>` у PartsTable → падає кейс «бейдж»; дати
 * механіку SEND_ROLES → падає кейс «механік».
 *
 * TECH-DEBT §14: нестачу рахує сервер за ЗБЕРЕЖЕНИМИ рядками — незбережені зміни товарів у діалог
 * не потрапляють, тож при відкритті діалогу картка попереджає (діалог при цьому відкривається).
 * Mutation-verify: `unsavedParts={0}` у CreateWorkOrderModal або прибрати `toast.warning` з
 * `SendToListButton` → падає кейс «змінена кількість»; рахувати всі рядки без порівняння з базою
 * → падає контроль «змінено лише шапку».
 */

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

let role = 'RECEPTIONIST';
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { role } }) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));
const toastWarning = vi.fn();
vi.mock('@/lib/toast', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/toast')>();
  return {
    ...actual,
    toast: { ...actual.toast, warning: (...a: unknown[]) => toastWarning(...a) },
  };
});
const UNSAVED_WARNING =
  'Незбережені товари наряду (нові рядки, змінені кількості) до списку не потраплять — спершу натисніть «Зберегти зміни»';

const WO = '10000000-0000-4000-8000-000000000001';
const B1 = '10000000-0000-4000-8000-000000000002';
const W1 = '10000000-0000-4000-8000-000000000005';
const G1 = '10000000-0000-4000-8000-000000000007';
const P1 = '10000000-0000-4000-8000-000000000008';

function mockApi() {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/branches') return Promise.resolve([{ id: B1, name: 'Філія №1' }]);
    if (path === '/warehouses') return Promise.resolve([{ id: W1, name: 'Склад №1' }]);
    if (path.startsWith('/employees')) return Promise.resolve({ items: [] });
    if (path.startsWith('/vehicles')) return Promise.resolve([]);
    if (path.includes('/contracts')) return Promise.resolve({ items: [] });
    if (path === '/settings/organisation') return Promise.resolve({ vatMode: 'NONE' });
    if (path === '/settings/tax-rates') return Promise.resolve([]);
    if (path.startsWith('/goods/stock-totals')) return Promise.resolve([]);
    if (path === `/work-orders/${WO}/linked-documents`) {
      return Promise.resolve({ invoices: [], payments: [], calendarSlots: [], warranties: [] });
    }
    if (path === `/purchase-list-items/by-work-order/${WO}`) {
      return Promise.resolve({
        items: [
          {
            id: 'i1',
            workOrderPartId: P1,
            status: 'ORDERED',
            listNumber: 'СК-2026-000001',
            purchaseOrderNumber: 'ЗП-7',
            purchaseOrderStatus: 'ORDERED',
            receivedQty: 0,
            reservedQty: 0,
          },
        ],
        shortage: [{ workOrderPartId: P1, shortage: 1 }],
      });
    }
    if (path === '/purchase-lists?status=OPEN&page=1&limit=100') {
      return Promise.resolve({ items: [], total: 0, page: 1, limit: 100 });
    }
    if (path === `/work-orders/${WO}?withDeleted=true`) {
      return Promise.resolve({
        id: WO,
        number: 'WO-001',
        status: 'APPROVED',
        branchId: B1,
        vehicleId: '10000000-0000-4000-8000-000000000003',
        counterpartyId: '10000000-0000-4000-8000-000000000004',
        counterpartyName: 'Тест',
        contractId: null,
        liftId: null,
        description: '',
        priority: 'NORMAL',
        repairCategory: '',
        documentDate: '2026-10-17',
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

describe('CreateWorkOrderModal — закупівля товарів наряду', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    mockApi();
    role = 'RECEPTIONIST';
    toastWarning.mockReset();
  });

  // guards: BR-PL-015
  it('бейдж: замовлено й нестача біля залишку збереженого рядка', async () => {
    renderWithQueryClient(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId={WO} />);
    const row = (await screen.findByText('Колодки гальмівні')).closest('tr')!;
    const badge = await within(row as HTMLElement).findByTestId('procurement-badge');
    expect(badge).toHaveTextContent('замовлено ЗП-7 (Замовлено)');
    expect(badge).toHaveTextContent('нестача 1');
  });

  // guards: BR-PL-003, BR-PL-015
  it('приймальня: «До списку купівлі» відкриває діалог з кількістю = нестача', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId={WO} />);
    await screen.findByTestId('procurement-badge');
    await user.click(screen.getByRole('button', { name: 'До списку купівлі' }));
    expect(await screen.findByLabelText('Кількість для Колодки гальмівні')).toHaveValue(1);
  });

  it('змінена кількість без «Зберегти зміни»: діалог відкривається з попередженням', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId={WO} />);
    await screen.findByTestId('procurement-badge');
    await user.click(screen.getByRole('button', { name: 'Редагувати товар' }));
    const row = screen.getByTitle('Зберегти').closest('tr')!;
    const qty = within(row).getByDisplayValue('3');
    await user.clear(qty);
    await user.type(qty, '5');
    await user.click(within(row).getByTitle('Зберегти'));

    await user.click(screen.getByRole('button', { name: 'До списку купівлі' }));
    expect(toastWarning).toHaveBeenCalledWith(UNSAVED_WARNING);
    // Попередження, не блокування: діалог зі збереженою нестачею відкрито.
    expect(await screen.findByLabelText('Кількість для Колодки гальмівні')).toHaveValue(1);
  });

  it('контроль: змінено лише шапку (форма «брудна»), товари збережені — попередження немає', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId={WO} />);
    await screen.findByTestId('procurement-badge');
    await user.type(screen.getByPlaceholderText('Заміна масла, колодок...'), 'Шум у гальмах');
    await user.click(screen.getByRole('button', { name: 'До списку купівлі' }));
    await screen.findByLabelText('Кількість для Колодки гальмівні');
    expect(toastWarning).not.toHaveBeenCalled();
  });

  // guards: BR-PL-002
  it('рядок у пакетах: нестача з базовою одиницею товару, а не одиницею рядка (Bug #886)', async () => {
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path === `/purchase-list-items/by-work-order/${WO}`) {
        return { items: [], shortage: [{ workOrderPartId: P1, shortage: 6, goodUnit: 'шт' }] };
      }
      const res = await base(path, ...rest);
      if (path === `/work-orders/${WO}?withDeleted=true`) {
        // 1.5 пакета, 1 пакет = 4 шт → бракує 6 шт (BR-PL-002).
        res.parts = [{ ...res.parts[0], quantity: 1.5, unitShortName: 'Пак' }];
      }
      return res;
    });
    const user = userEvent.setup();
    renderWithQueryClient(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId={WO} />);
    const badge = await screen.findByTestId('procurement-badge');
    expect(badge).toHaveTextContent('нестача 6 шт');
    await user.click(screen.getByRole('button', { name: 'До списку купівлі' }));
    const input = await screen.findByLabelText('Кількість для Колодки гальмівні');
    const dialogRow = input.closest('tr')!;
    expect(dialogRow).toHaveTextContent('6 шт');
    expect(dialogRow).not.toHaveTextContent('Пак');
  });

  // guards: BR-PL-015
  it('механік: стан бачить, а надсилати до списку не може', async () => {
    role = 'MECHANIC';
    renderWithQueryClient(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId={WO} />);
    await screen.findByTestId('procurement-badge');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'До списку купівлі' })).not.toBeInTheDocument(),
    );
  });
});
