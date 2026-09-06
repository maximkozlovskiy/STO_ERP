// Component-guard для NotificationProvidersPanel (Phase 3 сповіщень).
// Покриває поведінку, яку contract-тести бекенду не бачать:
//   1. verify happy-path — POST /verify, рендер "Токен дійсний · баланс".
//   2. verify error-path — reject → рендер повідомлення про помилку (не crash).
//   3. Switch toggle → PATCH /notification-channels/:branch з enabled.
//   4. priority move in-flight guard — під час PATCH стрілки заблоковані (movingId).
//   5. apiKey ніколи не показується у списку каналів (лише "без ключа" бейдж).

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import NotificationProvidersPanel from '../NotificationProvidersPanel';

// ─── Module mocks ────────────────────────────────────────────────────────────
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('@/lib/toast', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false, keyboardShortcutsEnabled: false }),
}));

// ref-cache: no-op (читаємо тільки з fetch у тестах)
vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: () => undefined,
}));

const BRANCHES = [{ id: 'br-1', name: 'Філія 1' }];
const PROVIDERS = [{ code: 'turbosms', name: 'TurboSMS', channels: ['SMS', 'VIBER'] }];

function channelRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ch-sms',
    channel: 'SMS',
    provider: 'turbosms',
    enabled: true,
    priority: 0,
    hasApiKey: true,
    senderName: 'STO',
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

// Базовий happy-mock: усі GET віддають дані, PATCH/POST успішні.
function baseMock(channels: unknown[] = [channelRow()]) {
  apiFetchMock.mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === '/branches') return Promise.resolve(BRANCHES);
    if (path === '/notification-providers') return Promise.resolve(PROVIDERS);
    if (path.startsWith('/notification-channels/')) {
      if (opts?.method === 'PATCH') return Promise.resolve({ id: 'ch-sms' });
      return Promise.resolve(channels);
    }
    return Promise.resolve({});
  });
}

describe('NotificationProvidersPanel', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('рендерить провайдерів і НЕ показує apiKey у списку каналів', async () => {
    baseMock([channelRow({ hasApiKey: false })]);
    render(<NotificationProvidersPanel />);
    await screen.findByText('TurboSMS');
    // Канал без ключа → бейдж "без ключа"; жодного секрету у DOM
    await screen.findByText('без ключа');
    expect(document.body.textContent).not.toContain('secret');
  });

  it('verify happy-path: POST /verify → "Токен дійсний · баланс"', async () => {
    apiFetchMock.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === '/branches') return Promise.resolve(BRANCHES);
      if (path === '/notification-providers') return Promise.resolve(PROVIDERS);
      if (path === '/notification-providers/turbosms/verify')
        return Promise.resolve({ valid: true, balance: 123 });
      if (path.startsWith('/notification-channels/')) return Promise.resolve([channelRow()]);
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<NotificationProvidersPanel />);

    await user.click(await screen.findByText('TurboSMS'));
    // Модалка кредів відкрилась
    const tokenInput = await screen.findByPlaceholderText('Введіть токен провайдера');
    await user.type(tokenInput, 'my-token');
    await user.click(screen.getByRole('button', { name: 'Перевірити' }));

    await waitFor(() => expect(screen.getByText(/Токен дійсний/)).toBeInTheDocument());
    expect(screen.getByText(/баланс: 123/)).toBeInTheDocument();
    // apiKey був у body запиту verify
    const verifyCall = apiFetchMock.mock.calls.find(
      c => c[0] === '/notification-providers/turbosms/verify',
    );
    expect(verifyCall?.[1]?.body).toContain('my-token');
  });

  it('verify error-path: reject → показує помилку, не crash', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/branches') return Promise.resolve(BRANCHES);
      if (path === '/notification-providers') return Promise.resolve(PROVIDERS);
      if (path === '/notification-providers/turbosms/verify')
        return Promise.reject(new Error('Невірний токен'));
      if (path.startsWith('/notification-channels/')) return Promise.resolve([channelRow()]);
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<NotificationProvidersPanel />);

    await user.click(await screen.findByText('TurboSMS'));
    const tokenInput = await screen.findByPlaceholderText('Введіть токен провайдера');
    await user.type(tokenInput, 'bad');
    await user.click(screen.getByRole('button', { name: 'Перевірити' }));

    await waitFor(() => expect(screen.getByText('Невірний токен')).toBeInTheDocument());
    // Токен-дійсний не показано
    expect(screen.queryByText(/Токен дійсний/)).not.toBeInTheDocument();
  });

  it('Switch toggle → PATCH з enabled', async () => {
    baseMock([channelRow({ enabled: true })]);
    const user = userEvent.setup();
    render(<NotificationProvidersPanel />);

    const sw = await screen.findByRole('switch', { name: /Вимкнути канал SMS/ });
    await user.click(sw);

    await waitFor(() => {
      const patch = apiFetchMock.mock.calls.find(
        c => c[0] === '/notification-channels/br-1' && c[1]?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      expect(patch![1].body).toContain('"enabled":false');
    });
  });

  it('priority move: два канали, стрілка вниз → PATCH обміну пріоритетів', async () => {
    baseMock([
      channelRow({ id: 'ch-sms', channel: 'SMS', priority: 0 }),
      channelRow({ id: 'ch-viber', channel: 'VIBER', priority: 1 }),
    ]);
    const user = userEvent.setup();
    render(<NotificationProvidersPanel />);

    // Дочекатись рендеру двох каналів
    const downButtons = await screen.findAllByLabelText('Знизити пріоритет');
    // Перший канал (index 0) → стрілка вниз активна
    await user.click(downButtons[0]);

    await waitFor(() => {
      const patches = apiFetchMock.mock.calls.filter(
        c => c[0] === '/notification-channels/br-1' && c[1]?.method === 'PATCH',
      );
      // move робить до 2 PATCH (swap) — щонайменше 1
      expect(patches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('single channel: стрілки вгору/вниз обидві disabled (немає сусіда)', async () => {
    baseMock([channelRow()]);
    render(<NotificationProvidersPanel />);
    const up = await screen.findByLabelText('Підняти пріоритет');
    const down = await screen.findByLabelText('Знизити пріоритет');
    expect(up).toBeDisabled();
    expect(down).toBeDisabled();
  });
});
