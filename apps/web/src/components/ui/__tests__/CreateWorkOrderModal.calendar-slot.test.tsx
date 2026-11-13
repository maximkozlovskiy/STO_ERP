/**
 * BR-WO-020 (скарга власника 2026-11-13): наряд, відкритий кнопкою «створити наряд» із форми
 * НАЯВНОГО запису календаря без наряду, шле в `POST /work-orders` `calendarSlotId` цього запису —
 * сервер прив'язує сам запис до наряду й ставить на його дати, а не створює другого. Без запису в
 * prefill поля в тілі немає; без планових дат — теж (наряд без дат, запис лишається формі).
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import { CreateWorkOrderModal, type CreateWOPrefill } from '../CreateWorkOrderModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { role: 'OWNER' } }) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

const SLOT = '44444444-4444-4444-8444-444444444444';
const BASE: CreateWOPrefill = {
  branchId: '11111111-1111-4111-8111-111111111111',
  counterpartyId: '22222222-2222-4222-8222-222222222222',
  counterpartyDisplay: 'Тест Клієнт',
  vehicleId: '33333333-3333-4333-8333-333333333333',
};

/** Планові дати запису — без них сервер запису наряду не віддає (BR-WO-020). */
const DATES = { plannedStartAt: '2030-06-03T10:00', plannedEndAt: '2030-06-03T12:00' };

type Call = [string, { method?: string; body?: string } | undefined];

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/branches') return Promise.resolve([{ id: BASE.branchId, name: 'Філія' }]);
    if (path === '/work-orders' && init?.method === 'POST')
      return Promise.resolve({ id: 'wo1', number: 'НРД-1', counterpartyId: BASE.counterpartyId });
    if (path.startsWith('/employees')) return Promise.resolve({ items: [] });
    return Promise.resolve([]);
  });
});

async function createBody(prefill: CreateWOPrefill): Promise<Record<string, unknown>> {
  renderWithQueryClient(<CreateWorkOrderModal open onClose={vi.fn()} prefill={prefill} />);
  const submit = screen.getByRole('button', { name: /Створити наряд/ });
  await waitFor(() => expect(submit).not.toBeDisabled(), { timeout: 2000 });
  await userEvent.click(submit);
  let post: Call | undefined;
  await waitFor(() => {
    post = (apiFetchMock.mock.calls as Call[]).find(
      ([p, i]) => p === '/work-orders' && i?.method === 'POST',
    );
    expect(post).toBeDefined();
  });
  return JSON.parse(post![1]!.body!) as Record<string, unknown>;
}

describe('CreateWorkOrderModal — наряд із наявного запису календаря (BR-WO-020)', () => {
  // guards: BR-WO-020
  it('prefill із записом календаря → `calendarSlotId` у тілі POST /work-orders', async () => {
    expect(await createBody({ ...BASE, ...DATES, calendarSlotId: SLOT })).toMatchObject({
      calendarSlotId: SLOT,
    });
  });

  // guards: BR-WO-020
  it('дати в картці стерто — `calendarSlotId` не шлеться: наряд без дат, а не 400', async () => {
    const body = await createBody({ ...BASE, calendarSlotId: SLOT });
    expect(body).not.toHaveProperty('calendarSlotId');
    expect(body).not.toHaveProperty('plannedAt');
  });

  // guards: BR-WO-020
  it('без запису в prefill — поля `calendarSlotId` у тілі немає', async () => {
    expect(await createBody(BASE)).not.toHaveProperty('calendarSlotId');
  });
});
