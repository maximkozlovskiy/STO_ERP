import { screen, waitFor, within } from '@testing-library/react';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { CreateWorkOrderModal } from '../CreateWorkOrderModal';

/**
 * Рядок «Додати» роботи й товару в картці наряду — клавіатура (UX-огляд 2026-10-29):
 *  - після «Додати» фокус у полі «Пошук роботи…» / «Пошук товару…» (було — на BODY);
 *  - Escape у відкритому рядку знімає лише рядок, картка лишається (механізм `useEscapeLayer`);
 *  - склад нового рядка товару підставлено (основний / єдиний / останній обраний), не порожній;
 *  - скорочення «К-сть», «ОВ», «Собів.» мають повну назву в `title`.
 *
 * Mutation-verify (2026-10-29): прибрати `useEscapeLayer` з WorksTable → падає «Escape у рядку
 * роботи»; прибрати `autoFocus` з поля пошуку → падає «фокус у пошуку»; `setNewPart(EMPTY_PART)`
 * у «Додати» → падає «склад підставлено».
 */

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { role: 'OWNER' } }) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));
const refCache = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/lib/ref-cache', () => ({
  getCached: (key: string) => refCache.get(key) ?? null,
  setCache: vi.fn((key: string, data: unknown) => refCache.set(key, data)),
}));
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

const WO = 'wo-kbd';

function mockApi() {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/branches') return Promise.resolve([{ id: 'b1', name: 'Філія №1' }]);
    if (path === '/warehouses')
      return Promise.resolve([
        { id: 'w-side', name: 'Бічний склад' },
        { id: 'w-main', name: 'Основний склад', isMain: true },
      ]);
    if (path === '/lifts') return Promise.resolve([]);
    if (path.startsWith('/employees')) return Promise.resolve({ items: [] });
    if (path.startsWith('/vehicles')) return Promise.resolve([]);
    if (path.includes('/contracts')) return Promise.resolve({ items: [] });
    if (path === '/settings/organisation') return Promise.resolve({ vatMode: 'NONE' });
    if (path === '/settings/tax-rates') return Promise.resolve([]);
    if (path === `/work-orders/${WO}/linked-documents`)
      return Promise.resolve({ invoices: [], payments: [], calendarSlots: [], warranties: [] });
    if (path === `/work-orders/${WO}?withDeleted=true`)
      return Promise.resolve({
        id: WO,
        number: 'НРД-KBD',
        status: 'DRAFT',
        branchId: 'b1',
        vehicleId: 'v1',
        counterpartyId: 'cp1',
        counterpartyName: 'Тест',
        contractId: null,
        liftId: null,
        description: '',
        priority: 'NORMAL',
        repairCategory: '',
        documentDate: '2026-10-22',
        plannedAt: null,
        dueDate: null,
        plannedHours: null,
        actualHours: null,
        lines: [],
        parts: [],
      });
    return Promise.resolve({ items: [] });
  });
}

async function openCard() {
  const user = userEvent.setup();
  const onClose = vi.fn();
  renderWithQueryClient(<CreateWorkOrderModal open onClose={onClose} workOrderId={WO} />);
  await screen.findByTestId('wo-works-section');
  await screen.findByText('НРД-KBD');
  return { user, onClose };
}

const works = () => screen.getByTestId('wo-works-section');
const parts = () => screen.getByTestId('wo-parts-section');

describe('Картка наряду — рядок «Додати» з клавіатури', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    refCache.clear();
    mockApi();
  });

  it('робота: після «Додати» фокус у пошуку; Escape знімає лише рядок, картка відкрита', async () => {
    const { user, onClose } = await openCard();
    await user.click(within(works()).getByRole('button', { name: 'Додати' }));
    const search = within(works()).getByRole('combobox', { name: 'Робота' });
    await waitFor(() => expect(search).toHaveFocus());

    await user.keyboard('{Escape}');

    expect(within(works()).queryByRole('combobox', { name: 'Робота' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Рядок знято — кнопка «Додати» повертається.
    expect(within(works()).getByRole('button', { name: 'Додати' })).toBeInTheDocument();
  });

  it('товар: фокус у пошуку, склад підставлено основним, Escape знімає лише рядок', async () => {
    const { user, onClose } = await openCard();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/warehouses'));
    await user.click(within(parts()).getByRole('button', { name: 'Додати' }));

    const search = within(parts()).getByRole('combobox', { name: 'Товар' });
    await waitFor(() => expect(search).toHaveFocus());
    const warehouse = within(parts()).getByRole('combobox', { name: 'Склад' }) as HTMLSelectElement;
    expect(warehouse.value).toBe('w-main');

    // Останній обраний склад лишається для наступного рядка.
    await user.selectOptions(warehouse, 'w-side');
    await user.click(search);
    await user.keyboard('{Escape}');
    expect(within(parts()).queryByRole('combobox', { name: 'Товар' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(within(parts()).getByRole('button', { name: 'Додати' }));
    expect(
      (within(parts()).getByRole('combobox', { name: 'Склад' }) as HTMLSelectElement).value,
    ).toBe('w-side');
  });

  it('скорочення в заголовках товарів — з повною назвою в title', async () => {
    const { user } = await openCard();
    await user.click(within(parts()).getByRole('button', { name: 'Додати' }));
    expect(within(parts()).getByText('К-сть')).toHaveAttribute('title', 'Кількість');
    expect(within(parts()).getByText('ОВ')).toHaveAttribute('title', 'Одиниця виміру');
    expect(within(parts()).getByText('Собів., ₴')).toHaveAttribute(
      'title',
      expect.stringMatching(/^Собівартість/),
    );
  });
});
