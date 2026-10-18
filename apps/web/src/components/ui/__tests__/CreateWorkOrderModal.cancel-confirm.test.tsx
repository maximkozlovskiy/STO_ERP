/**
 * BR-WO-025 — скасування в картці наряду з підтвердженням (рішення власника 2026-10-18).
 * Перехід «Скасувати» спершу відкриває підтвердження; зі статусу «Виконано» воно попереджає, що
 * товари повернуться на склад, а борг клієнта буде сторновано. «Ні» чи Escape закривають лише
 * підтвердження — картка лишається, наряд не змінюється. Текст той самий, що на сторінці наряду
 * (`cancelConfirmOptions`).
 */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { CreateWorkOrderModal } from '../CreateWorkOrderModal';
import { renderWithQueryClient } from '@/__tests__/query-utils';

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

const TITLE = 'Перевести наряд у статус "Скасовано"?';
const WARNING = 'Наряд уже виконано: товари повернуться на склад, а борг клієнта буде сторновано.';

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
      return Promise.resolve({ status: 'CANCELLED' });
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

const transitionCalls = () =>
  (apiFetchMock.mock.calls as Call[]).filter(([p]) => p === `/work-orders/${WO}/transition`);

/** Відкриває картку наряду в статусі `status` і тисне «Скасувати» в меню статусу. */
async function clickCancel(status: string) {
  mockApi(status);
  const onClose = vi.fn();
  const user = userEvent.setup();
  renderWithQueryClient(<CreateWorkOrderModal open onClose={onClose} workOrderId={WO} />);
  const menu = await screen.findByRole('button', { name: STATUS_LABEL[status] });
  await user.click(menu);
  // Пункт меню статусу (у картці є й інші кнопки «Скасувати»).
  const item = (await screen.findAllByRole('button', { name: 'Скасувати' })).find(btn =>
    btn.className.includes('text-left'),
  );
  await user.click(item!);
  return { user, onClose };
}

describe('CreateWorkOrderModal — скасування з підтвердженням (BR-WO-025)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  // guards: BR-WO-025
  it('«Скасувати» → спершу підтвердження, без переходу; «Так, скасувати» → перехід у «Скасовано»', async () => {
    const { user } = await clickCancel('DRAFT');

    const dialog = await screen.findByRole('dialog', { name: TITLE });
    expect(dialog.textContent).not.toContain(WARNING);
    expect(transitionCalls()).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Так, скасувати' }));
    await waitFor(() => expect(transitionCalls()).toHaveLength(1));
    expect(JSON.parse(transitionCalls()[0]![1]!.body!)).toEqual({ status: 'CANCELLED' });
  });

  // guards: BR-WO-025
  it('з «Виконано» → попередження: товари на склад, борг клієнта сторновано', async () => {
    await clickCancel('COMPLETED');

    const dialog = await screen.findByRole('dialog', { name: TITLE });
    expect(dialog.textContent).toContain(WARNING);
  });

  // guards: BR-WO-025
  it('«Ні» → підтвердження закрите, наряд не змінено, картка відкрита', async () => {
    const { user, onClose } = await clickCancel('COMPLETED');
    await screen.findByRole('dialog', { name: TITLE });

    await user.click(screen.getByRole('button', { name: 'Ні' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: TITLE })).toBeNull());
    expect(transitionCalls()).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });

  // guards: BR-WO-025
  it('Escape → закриває лише підтвердження (вкладена модалка), картка лишається', async () => {
    const { user, onClose } = await clickCancel('DRAFT');
    await screen.findByRole('dialog', { name: TITLE });

    await user.keyboard('{Escape}');
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: TITLE })).toBeNull());
    expect(transitionCalls()).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Наряд на роботу' })).toBeTruthy();
  });
});
