// Серверний дзвіночок (docs/objects/automation.md, BR-AUT-021, US-AUT-3): лічильник непрочитаних
// з `GET /notifications/me/unread-count` (опитування 30 с), список при відкритті, «прочитано»,
// «прочитати все», перехід до документа — лише ролі, яка має сторінку документа. Старий механізм
// localStorage прибрано: дзвіночок один.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let role = 'ADMIN';
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'me', role } }) }));
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }));

import { NotificationCenter } from '../notification-center';
import { NOTIFICATIONS_POLL_MS } from '@/hooks/api/useMyNotifications';

const WO = '11111111-1111-4111-8111-000000000001';
const INV = '11111111-1111-4111-8111-000000000002';
const ITEMS = [
  {
    id: 'n1',
    title: 'Наряд НРД-1 затверджено',
    body: 'Підготуйте пост',
    documentType: 'WORK_ORDER',
    documentId: WO,
    readAt: null,
    createdAt: '2026-10-30T08:00:00.000Z',
  },
  {
    id: 'n2',
    title: 'Рахунок РАХ-7 оплачено',
    body: null,
    documentType: 'INVOICE',
    documentId: INV,
    readAt: '2026-10-30T09:00:00.000Z',
    createdAt: '2026-10-30T07:00:00.000Z',
  },
];

let unread = 2;
const calls = (path: string, method = 'GET') =>
  apiFetchMock.mock.calls.filter(
    ([p, init]) => p === path && ((init as { method?: string })?.method ?? 'GET') === method,
  );

function renderBell(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NotificationCenter enabled={enabled} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  role = 'ADMIN';
  unread = 2;
  push.mockReset();
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (path === '/notifications/me/unread-count') return Promise.resolve({ count: unread });
    if (path.startsWith('/notifications/me?')) return Promise.resolve({ items: ITEMS, total: 2 });
    if (method === 'POST' && path === '/notifications/me/read-all') {
      unread = 0;
      return Promise.resolve({ updated: 1 });
    }
    if (method === 'POST' && path.endsWith('/read')) {
      unread = Math.max(0, unread - 1);
      return Promise.resolve({ ...ITEMS[0], readAt: '2026-10-30T10:00:00.000Z' });
    }
    return Promise.resolve({});
  });
});
afterEach(() => vi.useRealTimers());

const bell = () => screen.getByRole('button', { name: /Сповіщення/ });

describe('Дзвіночок — серверні сповіщення працівнику', () => {
  it('enabled=false → нічого не рендерить і не опитує сервер', () => {
    const { container } = renderBell(false);
    expect(container.firstChild).toBeNull();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  // guards: BR-AUT-021
  it('лічильник — з unread-count сервера; «9+», коли більше дев’яти; без localStorage', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    unread = 12;
    renderBell();
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('9+');
    expect(getItem.mock.calls.some(([k]) => k === 'sto_notifications')).toBe(false);
    getItem.mockRestore();
  });

  // guards: BR-AUT-021
  it('лічильник опитується раз на 30 с (як дашборд), список не читається до відкриття', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderBell();
    await waitFor(() => expect(calls('/notifications/me/unread-count')).toHaveLength(1));
    expect(NOTIFICATIONS_POLL_MS).toBe(30_000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTIFICATIONS_POLL_MS + 50);
    });
    await waitFor(() => expect(calls('/notifications/me/unread-count')).toHaveLength(2));
    expect(apiFetchMock.mock.calls.some(([p]) => String(p).startsWith('/notifications/me?'))).toBe(
      false,
    );
  });

  // guards: BR-AUT-021
  it('клік по непрочитаному: POST read і перехід у картку наряду (?open=)', async () => {
    renderBell();
    fireEvent.click(bell());
    fireEvent.click(await screen.findByText('Наряд НРД-1 затверджено'));
    await waitFor(() => expect(calls('/notifications/me/n1/read', 'POST')).toHaveLength(1));
    expect(push).toHaveBeenCalledWith(`/work-orders?open=${WO}`);
  });

  // guards: BR-AUT-021
  it('прочитане не позначається вдруге; роль без сторінки документа — лише текст, без переходу', async () => {
    role = 'MECHANIC';
    renderBell();
    fireEvent.click(bell());
    const item = await screen.findByText('Рахунок РАХ-7 оплачено');
    expect(item.closest('button')).not.toHaveTextContent('Відкрити документ');
    fireEvent.click(item);
    expect(calls('/notifications/me/n2/read', 'POST')).toHaveLength(0);
    expect(push).not.toHaveBeenCalled();
  });

  // guards: BR-AUT-021
  it('«Всі прочитано» → POST read-all, лічильник перечитується й зникає', async () => {
    renderBell();
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('2');
    fireEvent.click(bell());
    fireEvent.click(await screen.findByRole('button', { name: 'Всі прочитано' }));
    await waitFor(() => expect(calls('/notifications/me/read-all', 'POST')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('notification-badge')).toBeNull());
  });

  it('Escape закриває панель', async () => {
    renderBell();
    fireEvent.click(bell());
    expect(await screen.findByRole('dialog', { name: 'Сповіщення' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Сповіщення' })).toBeNull());
  });
});
