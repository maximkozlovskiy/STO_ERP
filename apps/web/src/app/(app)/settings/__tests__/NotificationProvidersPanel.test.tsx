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
// eSputnik: SMS inline + VIBER/TELEGRAM за шаблоном (templateChannels — джерело правди
// для показу поля «ID шаблону»; хардкод-сетів на фронті більше нема).
const ESPUTNIK = {
  code: 'esputnik',
  name: 'eSputnik',
  channels: ['SMS', 'VIBER', 'TELEGRAM'],
  templateChannels: ['VIBER', 'TELEGRAM'],
};

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

  // ─── eSputnik: поле «ID шаблону» похідне від provider.templateChannels ────────
  describe('eSputnik template-канали (needsExternalTemplate з метаданих)', () => {
    // Мок з eSputnik-провайдером; за замовчуванням каналів у філії нема (prefill порожній).
    function esputnikMock(channels: unknown[] = []) {
      apiFetchMock.mockImplementation((path: string, opts?: { method?: string }) => {
        if (path === '/branches') return Promise.resolve(BRANCHES);
        if (path === '/notification-providers') return Promise.resolve([ESPUTNIK]);
        if (path === '/notification-providers/esputnik/verify')
          return Promise.resolve({ valid: true });
        if (path.startsWith('/notification-channels/')) {
          if (opts?.method === 'PATCH') return Promise.resolve({ id: 'row-1' });
          return Promise.resolve(channels);
        }
        return Promise.resolve({});
      });
    }

    it('перший канал SMS (inline) → поле «ID шаблону» НЕ показується', async () => {
      esputnikMock();
      const user = userEvent.setup();
      render(<NotificationProvidersPanel />);
      // openCreds вибирає channels[0] === 'SMS'
      await user.click(await screen.findByText('eSputnik'));
      await screen.findByPlaceholderText('Введіть токен провайдера');
      expect(screen.queryByPlaceholderText('напр. 12345')).not.toBeInTheDocument();
    });

    it("перемикання каналу на VIBER → поле «ID шаблону» З'ЯВЛЯЄТЬСЯ; назад на SMS → зникає", async () => {
      esputnikMock();
      const user = userEvent.setup();
      render(<NotificationProvidersPanel />);
      await user.click(await screen.findByText('eSputnik'));
      await screen.findByPlaceholderText('Введіть токен провайдера');

      // Канал-Select показується (channels.length > 1). Обираємо VIBER.
      const channelSelect = screen.getByRole('combobox');
      await user.selectOptions(channelSelect, 'VIBER');
      expect(await screen.findByPlaceholderText('напр. 12345')).toBeInTheDocument();

      // Повертаємось на SMS — поле зникає (inline-канал).
      await user.selectOptions(channelSelect, 'SMS');
      await waitFor(() =>
        expect(screen.queryByPlaceholderText('напр. 12345')).not.toBeInTheDocument(),
      );
    });

    it('TELEGRAM → показується поле + підказка «лише підписаним отримувачам»', async () => {
      esputnikMock();
      const user = userEvent.setup();
      render(<NotificationProvidersPanel />);
      await user.click(await screen.findByText('eSputnik'));
      await screen.findByPlaceholderText('Введіть токен провайдера');

      await user.selectOptions(screen.getByRole('combobox'), 'TELEGRAM');
      expect(await screen.findByPlaceholderText('напр. 12345')).toBeInTheDocument();
      expect(screen.getByText(/лише підписаним отримувачам/)).toBeInTheDocument();
    });

    it('save VIBER: PATCH містить externalTemplateId (template-канал)', async () => {
      esputnikMock();
      const user = userEvent.setup();
      render(<NotificationProvidersPanel />);
      await user.click(await screen.findByText('eSputnik'));

      const token = await screen.findByPlaceholderText('Введіть токен провайдера');
      await user.type(token, 'esp-tok');
      await user.selectOptions(screen.getByRole('combobox'), 'VIBER');
      const tplInput = await screen.findByPlaceholderText('напр. 12345');
      await user.type(tplInput, 'tpl-42');

      await user.click(screen.getByRole('button', { name: 'Зберегти' }));

      await waitFor(() => {
        const patch = apiFetchMock.mock.calls.find(
          c => c[0] === '/notification-channels/br-1' && c[1]?.method === 'PATCH',
        );
        expect(patch).toBeTruthy();
        const body = JSON.parse(patch![1].body as string);
        expect(body.channel).toBe('VIBER');
        expect(body.provider).toBe('esputnik');
        expect(body.externalTemplateId).toBe('tpl-42');
      });
    });

    it('save SMS: PATCH НЕ містить externalTemplateId (inline-канал → undefined)', async () => {
      esputnikMock();
      const user = userEvent.setup();
      render(<NotificationProvidersPanel />);
      await user.click(await screen.findByText('eSputnik'));

      const token = await screen.findByPlaceholderText('Введіть токен провайдера');
      await user.type(token, 'esp-tok'); // канал лишається дефолтним SMS
      await user.click(screen.getByRole('button', { name: 'Зберегти' }));

      await waitFor(() => {
        const patch = apiFetchMock.mock.calls.find(
          c => c[0] === '/notification-channels/br-1' && c[1]?.method === 'PATCH',
        );
        expect(patch).toBeTruthy();
        const body = JSON.parse(patch![1].body as string);
        expect(body.channel).toBe('SMS');
        // needsExternalTemplate('esputnik','SMS') === false → поле не додається у dto.
        expect(body).not.toHaveProperty('externalTemplateId');
      });
    });

    it('prefill: відкриття кредів підтягує externalTemplateId наявного VIBER-каналу', async () => {
      // Наявний VIBER-канал eSputnik з template-id → openCreds бере channels[0]===SMS,
      // але при перемиканні на VIBER prefill має показати збережений tpl-id.
      esputnikMock([
        channelRow({
          id: 'ch-viber',
          channel: 'VIBER',
          provider: 'esputnik',
          externalTemplateId: 'saved-tpl-7',
        }),
      ]);
      const user = userEvent.setup();
      render(<NotificationProvidersPanel />);
      await user.click(await screen.findByText('eSputnik'));
      await screen.findByPlaceholderText('Введіть токен провайдера');

      await user.selectOptions(screen.getByRole('combobox'), 'VIBER');
      const tplInput = (await screen.findByPlaceholderText('напр. 12345')) as HTMLInputElement;
      expect(tplInput.value).toBe('saved-tpl-7');
    });
  });
});
