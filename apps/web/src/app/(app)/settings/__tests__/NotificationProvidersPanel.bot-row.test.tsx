// Рядок власного Telegram-бота в каналах філії (docs/objects/automation.md, BR-AUT-011, 040):
// картка провайдера з кредами організації — без поля ключа й без ексклюзивного перемикача; рядок
// бота додається вручну на останнє місце; «активний провайдер» його не враховує.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false, keyboardShortcutsEnabled: false }),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: () => undefined }));

import NotificationProvidersPanel from '../NotificationProvidersPanel';

const PROVIDERS = [
  { code: 'turbosms', name: 'TurboSMS', channels: ['SMS', 'VIBER'] },
  {
    code: 'telegram-bot',
    name: 'Telegram-бот СТО',
    channels: ['TELEGRAM_BOT'],
    orgCredentials: true,
  },
];
const row = (over: Record<string, unknown>) => ({
  id: 'ch',
  channel: 'SMS',
  provider: 'turbosms',
  enabled: true,
  priority: 0,
  hasApiKey: true,
  senderName: null,
  externalTemplateId: null,
  updatedAt: '2026-10-30T00:00:00.000Z',
  ...over,
});

let channels: unknown[];
const patches = () =>
  apiFetchMock.mock.calls
    .filter(
      ([p, init]) =>
        String(p).startsWith('/notification-channels/') &&
        (init as { method?: string })?.method === 'PATCH',
    )
    .map(([, init]) => JSON.parse((init as { body: string }).body) as Record<string, unknown>);

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/branches') return Promise.resolve([{ id: 'br-1', name: 'Філія' }]);
    if (path === '/notification-providers') return Promise.resolve(PROVIDERS);
    if (path.startsWith('/notification-channels/'))
      return Promise.resolve(init?.method === 'PATCH' ? { id: 'x' } : channels);
    return Promise.resolve({});
  });
});

describe('Telegram-бот у каналах філії', () => {
  // guards: BR-AUT-011, BR-AUT-040
  it('картка бота — без перемикача активації й ключа; «Додати до каналів» → рядок на останнє місце', async () => {
    channels = [
      row({ id: 'sms', priority: 0 }),
      row({ id: 'viber', channel: 'VIBER', priority: 3 }),
    ];
    render(<NotificationProvidersPanel />);
    const card = await screen
      .findByText('Telegram-бот СТО')
      .then(el => el.closest('[data-provider]') as HTMLElement);
    expect(within(card).queryByRole('switch')).toBeNull();
    const add = within(card).getByRole('button', { name: /Додати до каналів/ });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    await waitFor(() =>
      expect(patches()).toEqual([
        { channel: 'TELEGRAM_BOT', provider: 'telegram-bot', enabled: true, priority: 4 },
      ]),
    );
    // Вікна кредів (ключ) для бота немає.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // guards: BR-AUT-011
  it('рядок бота не робить бота «активним провайдером» і вмикається поруч з активним', async () => {
    channels = [
      row({
        id: 'bot',
        channel: 'TELEGRAM_BOT',
        provider: 'telegram-bot',
        priority: 0,
        enabled: false,
        hasApiKey: false,
      }),
      row({ id: 'sms', priority: 1, enabled: true }),
    ];
    render(<NotificationProvidersPanel />);
    const turbo = await screen.findByRole('switch', { name: /TurboSMS/ });
    // Канали читаються після провайдерів — чекаємо на їхній стан, а не на першу відмальовку.
    await waitFor(() => expect(turbo).toBeChecked());
    expect(screen.getByText('бот не підключено')).toBeInTheDocument();
    const botToggle = screen
      .getAllByRole('switch')
      .find(s => /Telegram-бот/.test(s.getAttribute('aria-label') ?? ''))!;
    expect(botToggle).toBeEnabled();
    fireEvent.click(botToggle);
    await waitFor(() =>
      expect(patches()).toEqual([
        { channel: 'TELEGRAM_BOT', provider: 'telegram-bot', enabled: true },
      ]),
    );
  });

  it('бот уже в каналах філії — картка каже це замість кнопки', async () => {
    channels = [row({ id: 'bot', channel: 'TELEGRAM_BOT', provider: 'telegram-bot', priority: 0 })];
    render(<NotificationProvidersPanel />);
    expect(await screen.findByText('У каналах філії')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Додати до каналів/ })).toBeNull();
  });
});
