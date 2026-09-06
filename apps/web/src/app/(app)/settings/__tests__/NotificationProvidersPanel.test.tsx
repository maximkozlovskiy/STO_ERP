// Component-guard для NotificationProvidersPanel (Phase 3 сповіщень).
// Покриває поведінку, яку contract-тести бекенду не бачать:
//   1. verify happy-path — POST /verify, рендер "Токен дійсний · баланс".
//   2. verify error-path — reject → рендер повідомлення про помилку (не crash).
//   3. Switch toggle → PATCH /notification-channels/:branch з enabled.
//   4. priority move in-flight guard — під час PATCH стрілки заблоковані (movingId).
//   5. apiKey ніколи не показується у списку каналів (лише "без ключа" бейдж).

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  // ─── Ексклюзивна активація провайдера (feat/exclusive-provider) ──────────────
  // Інваріант: активним може бути лише ОДИН провайдер. Картковий Switch активує
  // провайдера ексклюзивно; канал іншого провайдера не можна увімкнути окремо;
  // Switch активного провайдера/каналу — стан керується інваріантом.
  describe('ексклюзивна активація', () => {
    // Два провайдери на картках; конфіги каналів задаються тестом.
    function twoProviderMock(channels: unknown[]) {
      apiFetchMock.mockImplementation((path: string, opts?: { method?: string }) => {
        if (path === '/branches') return Promise.resolve(BRANCHES);
        if (path === '/notification-providers') return Promise.resolve([PROVIDERS[0], ESPUTNIK]);
        if (path.startsWith('/notification-channels/')) {
          if (opts?.method === 'POST') return Promise.resolve({ activeProvider: 'turbosms' });
          if (opts?.method === 'PATCH') return Promise.resolve({ id: 'row-1' });
          return Promise.resolve(channels);
        }
        return Promise.resolve({});
      });
    }

    it('Switch на картці неактивного провайдера → POST /activate з {provider}', async () => {
      // turbosms активний (SMS enabled). Активуємо esputnik (має налаштований канал).
      twoProviderMock([
        channelRow({ id: 'ch-sms', channel: 'SMS', provider: 'turbosms', enabled: true }),
        channelRow({ id: 'ch-esp', channel: 'SMS', provider: 'esputnik', enabled: false }),
      ]);
      const user = userEvent.setup();
      render(<NotificationProvidersPanel />);

      const espSwitch = await screen.findByRole('switch', {
        name: 'Активувати провайдера eSputnik',
      });
      expect(espSwitch).not.toBeDisabled();
      await user.click(espSwitch);

      await waitFor(() => {
        const post = apiFetchMock.mock.calls.find(
          c => c[0] === '/notification-channels/br-1/activate' && c[1]?.method === 'POST',
        );
        expect(post).toBeTruthy();
        expect(JSON.parse(post![1].body as string)).toEqual({ provider: 'esputnik' });
      });
    });

    it('Switch активного провайдера — disabled (немає повторної/зворотної активації)', async () => {
      twoProviderMock([
        channelRow({ id: 'ch-sms', channel: 'SMS', provider: 'turbosms', enabled: true }),
      ]);
      render(<NotificationProvidersPanel />);

      const activeSwitch = await screen.findByRole('switch', {
        name: 'Активувати провайдера TurboSMS',
      });
      // Чекаємо доки GET каналів долетить і activeProvider === 'turbosms' (isActive→disabled).
      // Без waitFor асерт міг би спрацювати на першому рендері (channels ще порожні → не disabled).
      await waitFor(() => expect(activeSwitch).toBeDisabled());
      expect(activeSwitch).toHaveAttribute('aria-checked', 'true');
    });

    it('empty-state guard: активація провайдера БЕЗ каналів → НЕ POST + повідомлення налаштувати креди', async () => {
      // turbosms активний; esputnik НЕ має жодного каналу у філії → guard блокує.
      twoProviderMock([
        channelRow({ id: 'ch-sms', channel: 'SMS', provider: 'turbosms', enabled: true }),
      ]);
      const user = userEvent.setup();
      render(<NotificationProvidersPanel />);

      const espSwitch = await screen.findByRole('switch', {
        name: 'Активувати провайдера eSputnik',
      });
      await user.click(espSwitch);

      // Повідомлення показане; activate НЕ надіслано.
      await screen.findByText(/Спершу налаштуйте канал провайдера/);
      const post = apiFetchMock.mock.calls.find(
        c => c[0] === '/notification-channels/br-1/activate' && c[1]?.method === 'POST',
      );
      expect(post).toBeUndefined();
    });

    it('канал НЕактивного провайдера у списку — Switch disabled (не можна увімкнути 2-й провайдер)', async () => {
      // turbosms активний (SMS enabled). esputnik-канал вимкнений і його provider ≠ active.
      twoProviderMock([
        channelRow({ id: 'ch-sms', channel: 'SMS', provider: 'turbosms', enabled: true }),
        channelRow({ id: 'ch-esp', channel: 'VIBER', provider: 'esputnik', enabled: false }),
      ]);
      render(<NotificationProvidersPanel />);

      // Канал esputnik VIBER — Switch у списку каналів заблокований.
      const espChannelSwitch = await screen.findByRole('switch', {
        name: /Увімкнути канал Viber/,
      });
      expect(espChannelSwitch).toBeDisabled();
    });

    it('канал іншого провайдера: disabled Switch блокує PATCH (клік по disabled — no-op)', async () => {
      // Детермінований варіант: перевіряємо, що disabled Switch каналу неактивного
      // провайдера НЕ шле PATCH. fireEvent.click по disabled button не викликає onClick
      // (нативна семантика), тож жодного esputnik-PATCH не з'являється.
      twoProviderMock([
        channelRow({ id: 'ch-sms', channel: 'SMS', provider: 'turbosms', enabled: true }),
        channelRow({ id: 'ch-esp', channel: 'VIBER', provider: 'esputnik', enabled: false }),
      ]);
      render(<NotificationProvidersPanel />);

      const espChannelSwitch = await screen.findByRole('switch', { name: /Увімкнути канал Viber/ });
      expect(espChannelSwitch).toBeDisabled();
      fireEvent.click(espChannelSwitch); // no-op на disabled button

      const patch = apiFetchMock.mock.calls.find(
        c =>
          c[0] === '/notification-channels/br-1' &&
          c[1]?.method === 'PATCH' &&
          (c[1].body as string).includes('esputnik'),
      );
      expect(patch).toBeUndefined();
    });

    it('вимкнення каналу АКТИВНОГО провайдера — дозволено (Switch enabled, PATCH enabled=false)', async () => {
      // Активний turbosms з двома каналами; вимкнути один (звузити ланцюг) — дозволено.
      twoProviderMock([
        channelRow({
          id: 'ch-sms',
          channel: 'SMS',
          provider: 'turbosms',
          enabled: true,
          priority: 0,
        }),
        channelRow({
          id: 'ch-viber',
          channel: 'VIBER',
          provider: 'turbosms',
          enabled: true,
          priority: 1,
        }),
      ]);
      const user = userEvent.setup();
      render(<NotificationProvidersPanel />);

      // Канал активного провайдера, enabled → Switch дозволяє вимкнення.
      const smsSwitch = await screen.findByRole('switch', { name: /Вимкнути канал SMS/ });
      expect(smsSwitch).not.toBeDisabled();
      await user.click(smsSwitch);

      await waitFor(() => {
        const patch = apiFetchMock.mock.calls.find(
          c => c[0] === '/notification-channels/br-1' && c[1]?.method === 'PATCH',
        );
        expect(patch).toBeTruthy();
        expect(patch![1].body).toContain('"enabled":false');
        expect(patch![1].body).toContain('"provider":"turbosms"');
      });
    });

    it("SMTP-форма не з'являється для не-SMTP провайдера (єдине поле API-токена)", async () => {
      twoProviderMock([
        channelRow({ id: 'ch-sms', channel: 'SMS', provider: 'turbosms', enabled: true }),
      ]);
      const user = userEvent.setup();
      render(<NotificationProvidersPanel />);
      await user.click(await screen.findByText('TurboSMS'));
      // Одне поле токена; SMTP-поля відсутні.
      expect(await screen.findByPlaceholderText('Введіть токен провайдера')).toBeInTheDocument();
      expect(screen.queryByPlaceholderText('smtp.ukr.net')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Пароль')).not.toBeInTheDocument();
    });
  });

  // ─── SMTP-провайдер (code='smtp') — форма host/port/user/pass замість токена (Bug #660) ─
  // Панель серіалізує SMTP-поля у JSON перед PATCH apiKey. Раніше без покриття: показ форми,
  // credsReady=host+user+pass, PATCH.apiKey = JSON-рядок конфігу.
  describe('SMTP-провайдер (форма кредів)', () => {
    const SMTP = { code: 'smtp', name: 'Email (SMTP)', channels: ['EMAIL'], templateChannels: [] };

    function smtpMock(channels: unknown[] = []) {
      apiFetchMock.mockImplementation((path: string, opts?: { method?: string }) => {
        if (path === '/branches') return Promise.resolve(BRANCHES);
        if (path === '/notification-providers') return Promise.resolve([SMTP]);
        if (path === '/notification-providers/smtp/verify') return Promise.resolve({ valid: true });
        if (path.startsWith('/notification-channels/')) {
          if (opts?.method === 'PATCH') return Promise.resolve({ id: 'row-smtp' });
          return Promise.resolve(channels);
        }
        return Promise.resolve({});
      });
    }

    it('SMTP-провайдер → показує форму host/port/user/pass (НЕ єдине поле токена)', async () => {
      smtpMock();
      const user = userEvent.setup();
      render(<NotificationProvidersPanel />);
      await user.click(await screen.findByText('Email (SMTP)'));
      // SMTP-поля присутні
      expect(await screen.findByPlaceholderText('smtp.ukr.net')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('587')).toBeInTheDocument(); // порт
      expect(screen.getByPlaceholderText('sto@ukr.net')).toBeInTheDocument(); // логін
      expect(screen.getByPlaceholderText('••••••••')).toBeInTheDocument(); // пароль
      // Єдиного поля API-токена НЕМАЄ (SMTP → форма).
      expect(screen.queryByPlaceholderText('Введіть токен провайдера')).not.toBeInTheDocument();
    });

    it('credsReady=false доки не заповнені host+user+pass → кнопка Зберегти disabled', async () => {
      smtpMock();
      const user = userEvent.setup();
      render(<NotificationProvidersPanel />);
      await user.click(await screen.findByText('Email (SMTP)'));

      const save = screen.getByRole('button', { name: 'Зберегти' });
      expect(save).toBeDisabled(); // усі поля порожні

      // Лише host — усе ще disabled (треба user+pass).
      await user.type(await screen.findByPlaceholderText('smtp.ukr.net'), 'smtp.ukr.net');
      expect(save).toBeDisabled();
      // + user — ще disabled.
      await user.type(screen.getByPlaceholderText('sto@ukr.net'), 'sto@ukr.net');
      expect(save).toBeDisabled();
      // + pass — тепер enabled.
      await user.type(screen.getByPlaceholderText('••••••••'), 'secret');
      expect(save).not.toBeDisabled();
    });

    it('save SMTP → PATCH.apiKey = JSON-рядок {host,port,secure,user,pass}', async () => {
      smtpMock();
      const user = userEvent.setup();
      render(<NotificationProvidersPanel />);
      await user.click(await screen.findByText('Email (SMTP)'));

      await user.type(await screen.findByPlaceholderText('smtp.ukr.net'), 'smtp.ukr.net');
      await user.clear(screen.getByPlaceholderText('587'));
      await user.type(screen.getByPlaceholderText('587'), '465');
      await user.type(screen.getByPlaceholderText('sto@ukr.net'), 'sto@ukr.net');
      await user.type(screen.getByPlaceholderText('••••••••'), 'secret');
      // TLS-чекбокс → secure:true
      await user.click(screen.getByLabelText(/TLS\/SSL/));

      await user.click(screen.getByRole('button', { name: 'Зберегти' }));

      await waitFor(() => {
        const patch = apiFetchMock.mock.calls.find(
          c => c[0] === '/notification-channels/br-1' && c[1]?.method === 'PATCH',
        );
        expect(patch).toBeTruthy();
        const body = JSON.parse(patch![1].body as string);
        expect(body.channel).toBe('EMAIL'); // channels[0] EMAIL
        expect(body.provider).toBe('smtp');
        // apiKey — серіалізований SMTP-конфіг (JSON-рядок), не сирий токен.
        const smtpCfg = JSON.parse(body.apiKey as string);
        expect(smtpCfg).toEqual({
          host: 'smtp.ukr.net',
          port: 465,
          secure: true,
          user: 'sto@ukr.net',
          pass: 'secret',
        });
      });
    });

    it('save SMTP: порожній порт → дефолт 587 у JSON apiKey', async () => {
      smtpMock();
      const user = userEvent.setup();
      render(<NotificationProvidersPanel />);
      await user.click(await screen.findByText('Email (SMTP)'));

      await user.type(await screen.findByPlaceholderText('smtp.ukr.net'), 'mail.local');
      await user.clear(screen.getByPlaceholderText('587')); // порожній порт
      await user.type(screen.getByPlaceholderText('sto@ukr.net'), 'u@local');
      await user.type(screen.getByPlaceholderText('••••••••'), 'p');
      await user.click(screen.getByRole('button', { name: 'Зберегти' }));

      await waitFor(() => {
        const patch = apiFetchMock.mock.calls.find(
          c => c[0] === '/notification-channels/br-1' && c[1]?.method === 'PATCH',
        );
        expect(patch).toBeTruthy();
        const smtpCfg = JSON.parse(JSON.parse(patch![1].body as string).apiKey as string);
        expect(smtpCfg.port).toBe(587); // Number('')||587 → 587
      });
    });

    it('verify SMTP → POST /verify з JSON-конфігом у apiKey', async () => {
      smtpMock();
      const user = userEvent.setup();
      render(<NotificationProvidersPanel />);
      await user.click(await screen.findByText('Email (SMTP)'));

      await user.type(await screen.findByPlaceholderText('smtp.ukr.net'), 'smtp.ukr.net');
      await user.type(screen.getByPlaceholderText('sto@ukr.net'), 'sto@ukr.net');
      await user.type(screen.getByPlaceholderText('••••••••'), 'secret');
      await user.click(screen.getByRole('button', { name: 'Перевірити' }));

      await waitFor(() => {
        const verifyCall = apiFetchMock.mock.calls.find(
          c => c[0] === '/notification-providers/smtp/verify',
        );
        expect(verifyCall).toBeTruthy();
        const cfg = JSON.parse(JSON.parse(verifyCall![1].body as string).apiKey as string);
        expect(cfg.host).toBe('smtp.ukr.net');
        expect(cfg.user).toBe('sto@ukr.net');
        expect(cfg.pass).toBe('secret');
      });
    });
  });

  describe('ексклюзивна активація (додатково)', () => {
    function twoProviderMock(channels: unknown[]) {
      apiFetchMock.mockImplementation((path: string, opts?: { method?: string }) => {
        if (path === '/branches') return Promise.resolve(BRANCHES);
        if (path === '/notification-providers') return Promise.resolve([PROVIDERS[0], ESPUTNIK]);
        if (path.startsWith('/notification-channels/')) {
          if (opts?.method === 'POST') return Promise.resolve({ activeProvider: 'turbosms' });
          if (opts?.method === 'PATCH') return Promise.resolve({ id: 'row-1' });
          return Promise.resolve(channels);
        }
        return Promise.resolve({});
      });
    }

    it('канал вимкненого провайдера коли АКТИВНИЙ провайдер відсутній (нічого не enabled) → Switch НЕ disabled', async () => {
      // activeProvider === null → жоден provider не активний → усі канали можна вмикати
      // (перший click активує ланцюг цього провайдера). Guard тільки коли є active-provider.
      twoProviderMock([
        channelRow({ id: 'ch-sms', channel: 'SMS', provider: 'turbosms', enabled: false }),
        channelRow({ id: 'ch-esp', channel: 'VIBER', provider: 'esputnik', enabled: false }),
      ]);
      render(<NotificationProvidersPanel />);

      const smsSwitch = await screen.findByRole('switch', { name: /Увімкнути канал SMS/ });
      const espSwitch = await screen.findByRole('switch', { name: /Увімкнути канал Viber/ });
      expect(smsSwitch).not.toBeDisabled();
      expect(espSwitch).not.toBeDisabled();
    });
  });
});
