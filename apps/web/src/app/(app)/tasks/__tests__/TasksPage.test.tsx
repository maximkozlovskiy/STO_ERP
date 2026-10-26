// Сторінка «Задачі» (docs/objects/task.md): чип «Мої задачі» типово увімкнений для ролей поза
// керуванням (BR-TASK-002), «+ Задача» — лише ролям керування (BR-TASK-001), прострочена задача
// підсвічена (BR-TASK-005), «Взяти в роботу» з рядка — перехід статусу (BR-TASK-003).

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/tasks',
}));
let actor = { id: 'mgr-1', role: 'ADMIN' };
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: actor }),
  useRequireAuth: () => ({ employee: actor }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import TasksPage from '../page';

const MECH = '11111111-1111-4111-8111-00000000000a';
const ROW = {
  id: '55555555-5555-4555-8555-000000000001',
  title: 'Перевірити гальма',
  description: null,
  status: 'NEW',
  priority: 'HIGH',
  assigneeId: MECH,
  assigneeName: 'Коваль Іван',
  createdById: 'mgr-1',
  createdByName: 'Адмін СТО',
  startAt: null,
  dueAt: '2026-10-20T10:00:00.000Z',
  completedAt: null,
  workOrderId: null,
  workOrderNumber: 'НРД-7',
  workOrderDeleted: true,
  vehicleId: null,
  vehicleSummary: null,
  counterpartyId: null,
  counterpartyName: null,
  overdue: true,
  syncVersion: 1,
  createdAt: '2026-10-19T08:00:00.000Z',
  updatedAt: '2026-10-19T08:00:00.000Z',
};

const listCalls = () =>
  apiFetchMock.mock.calls.map(c => String(c[0])).filter(p => p.startsWith('/tasks?'));
const lastListParams = () => new URLSearchParams(listCalls().at(-1)!.split('?')[1]);

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TasksPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  actor = { id: 'mgr-1', role: 'ADMIN' };
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
    if (path.startsWith('/tasks?'))
      return Promise.resolve({ items: [ROW], total: 1, page: 1, limit: 20 });
    if (path.startsWith('/employees')) return Promise.resolve({ items: [], total: 0 });
    if (init?.method === 'POST' && path.endsWith('/transition'))
      return Promise.resolve({ ...ROW, status: 'IN_PROGRESS' });
    return Promise.resolve({ items: [], total: 0 });
  });
});

describe('Сторінка «Задачі»', () => {
  // guards: BR-TASK-002
  it('механік: «Мої задачі» увімкнено типово (mine=true у запиті), «+ Задача» немає', async () => {
    actor = { id: MECH, role: 'MECHANIC' };
    renderPage();
    const mine = await screen.findByRole('button', { name: 'Мої задачі' });
    await waitFor(() => expect(mine).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(lastListParams().get('mine')).toBe('true'));
    expect(screen.queryByRole('button', { name: 'Задача' })).toBeNull();
  });

  // guards: BR-TASK-002, BR-TASK-001
  it('керівник: чип вимкнений (без mine), «+ Задача» є', async () => {
    renderPage();
    await screen.findByText('Перевірити гальма');
    expect(screen.getByRole('button', { name: 'Мої задачі' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(lastListParams().get('mine')).toBeNull();
    expect(screen.getByRole('button', { name: 'Задача' })).toBeInTheDocument();
  });

  // guards: BR-TASK-005, BR-TASK-006
  it('прострочена задача — позначка й підсвічений рядок; видалений наряд — «(видалений)»', async () => {
    renderPage();
    const row = (await screen.findByText('Перевірити гальма')).closest('tr') as HTMLElement;
    expect(row).toHaveAttribute('data-overdue', 'true');
    expect(within(row).getByText('Прострочена')).toBeInTheDocument();
    expect(within(row).getByText('НРД-7 (видалений)')).toBeInTheDocument();
  });

  // guards: BR-TASK-005
  it('чип «Прострочені» → overdue=true у запиті', async () => {
    renderPage();
    await screen.findByText('Перевірити гальма');
    fireEvent.click(screen.getByRole('button', { name: 'Прострочені' }));
    await waitFor(() => expect(lastListParams().get('overdue')).toBe('true'));
  });

  // guards: BR-TASK-003
  it('виконавець своєї задачі: «Взяти в роботу» з рядка → transition IN_PROGRESS', async () => {
    actor = { id: MECH, role: 'MECHANIC' };
    renderPage();
    const btn = await screen.findByRole('button', { name: 'Взяти в роботу: Перевірити гальма' });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(
        apiFetchMock.mock.calls.some(
          ([p, i]) => String(p).endsWith(`/tasks/${ROW.id}/transition`) && i?.method === 'POST',
        ),
      ).toBe(true),
    );
  });
});
