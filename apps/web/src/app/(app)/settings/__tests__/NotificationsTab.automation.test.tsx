// Вкладка «Сповіщення» після автоматизації (docs/objects/automation.md, BR-AUT-007, 013, 040):
// тихі години (PATCH лише двох полів), підключення Telegram-бота з підказкою про канали філії,
// шаблони, які замінили типові правила, не редагуються — примітка з посиланням на правило.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: () => undefined }));
vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false, keyboardShortcutsEnabled: false }),
}));

import NotificationsTab from '../NotificationsTab';

const RULE_ID = '55555555-5555-4555-8555-000000000001';
let bot = { connected: false, username: null as string | null };
const calls = (path: string, method: string) =>
  apiFetchMock.mock.calls.filter(
    ([p, init]) => p === path && ((init as { method?: string })?.method ?? 'GET') === method,
  );

beforeEach(() => {
  bot = { connected: false, username: null };
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (path === '/settings/organisation' && method === 'PATCH')
      return Promise.resolve(JSON.parse(init!.body!));
    if (path === '/settings/organisation')
      return Promise.resolve({ quietHoursStart: '21:00', quietHoursEnd: '09:00', currency: 'UAH' });
    if (path === '/settings/telegram-bot' && method === 'PUT') {
      bot = { connected: true, username: 'sto_demo_bot' };
      return Promise.resolve(bot);
    }
    if (path === '/settings/telegram-bot') return Promise.resolve(bot);
    if (path === '/notification-templates')
      return Promise.resolve([
        {
          id: 't1',
          eventType: 'WO_COMPLETED',
          channel: 'SMS',
          subject: null,
          body: 'Готово',
          isActive: true,
        },
        {
          id: 't2',
          eventType: 'WO_ESTIMATE_READY',
          channel: 'SMS',
          subject: null,
          body: 'Кошторис {{link}}',
          isActive: true,
        },
        {
          id: 't3',
          eventType: 'PAYMENT_RECEIVED',
          channel: 'SMS',
          subject: null,
          body: 'Оплата',
          isActive: true,
        },
      ]);
    if (path.startsWith('/automation/rules'))
      return Promise.resolve({
        items: [{ id: RULE_ID, systemKey: 'WO_COMPLETED_CLIENT', name: 'Наряд виконано' }],
        total: 1,
      });
    if (path === '/branches') return Promise.resolve([]);
    if (path === '/notification-providers') return Promise.resolve([]);
    return Promise.resolve([]);
  });
});

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NotificationsTab />
    </QueryClientProvider>,
  );
}

describe('Сповіщення — автоматизація', () => {
  // guards: BR-AUT-013
  it('тихі години: межі з налаштувань, PATCH лише quietHoursStart / quietHoursEnd', async () => {
    renderTab();
    const start = await screen.findByLabelText('Початок');
    expect(start).toHaveValue('21:00');
    fireEvent.change(start, { target: { value: '22:30' } });
    fireEvent.change(screen.getByLabelText('Кінець'), { target: { value: '08:00' } });
    fireEvent.click(screen.getByTestId('quiet-hours').querySelector('button')!);
    await waitFor(() => expect(calls('/settings/organisation', 'PATCH')).toHaveLength(1));
    expect(
      JSON.parse((calls('/settings/organisation', 'PATCH')[0]![1] as { body: string }).body),
    ).toEqual({
      quietHoursStart: '22:30',
      quietHoursEnd: '08:00',
    });
  });

  // guards: BR-AUT-013 (Bug #1005)
  it('тихі години: порожній / недонабраний час — пояснення формату під полем, без PATCH', async () => {
    renderTab();
    const start = await screen.findByLabelText('Початок');
    expect(screen.queryByText('Вкажіть час у форматі ГГ:ХХ (00:00–23:59)')).toBeNull();
    fireEvent.change(start, { target: { value: '' } });
    expect(screen.getByText('Вкажіть час у форматі ГГ:ХХ (00:00–23:59)')).toBeInTheDocument();
    const save = screen.getByTestId('quiet-hours').querySelector('button')!;
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(calls('/settings/organisation', 'PATCH')).toHaveLength(0);
    fireEvent.change(start, { target: { value: '22:00' } });
    expect(screen.queryByText('Вкажіть час у форматі ГГ:ХХ (00:00–23:59)')).toBeNull();
  });

  // guards: BR-AUT-040
  it('бот: «Підключити» → PUT з токеном, ім’я бота й підказка додати канал у філії', async () => {
    renderTab();
    fireEvent.change(await screen.findByLabelText('Токен бота'), {
      target: { value: ' 123456789:AAtoken ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Підключити' }));
    await waitFor(() => expect(calls('/settings/telegram-bot', 'PUT')).toHaveLength(1));
    expect(
      JSON.parse((calls('/settings/telegram-bot', 'PUT')[0]![1] as { body: string }).body),
    ).toEqual({
      token: '123456789:AAtoken',
    });
    expect(await screen.findByText('Підключено: @sto_demo_bot')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Додайте канал Telegram-бот у налаштуваннях каналів філії і поставте його на потрібне місце',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Токен бота')).toBeNull();
  });

  // guards: BR-AUT-007
  it('шаблони, замінені типовими правилами, не редагуються — примітка з посиланням на правило', async () => {
    renderTab();
    expect(await screen.findByText('Кошторис {{link}}')).toBeInTheDocument();
    expect(screen.queryByText('Готово')).toBeNull();
    expect(screen.queryByText('Оплата')).toBeNull();
    const note = screen.getByTestId('legacy-templates-note');
    await waitFor(() =>
      expect(note.querySelector(`a[href="/settings/automation?open=${RULE_ID}"]`)).not.toBeNull(),
    );
  });
});
