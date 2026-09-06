import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NotificationChannel } from '@prisma/client';
import { TurboSmsProvider } from './turbosms.provider';
import { EsputnikProvider } from './esputnik.provider';
import { NotificationProviderRegistry } from './provider-registry';

/**
 * TurboSMS provider — SMS parity + verifyCredentials (токен+баланс без тест-SMS).
 * fetch мокається; перевіряємо мапінг response_code → accepted/valid.
 */
describe('TurboSmsProvider', () => {
  let provider: TurboSmsProvider;
  const fetchMock = vi.fn();

  beforeEach(() => {
    provider = new TurboSmsProvider();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  const okResponse = (json: unknown) => ({ ok: true, json: async () => json }) as Response;

  it('send SMS: response_code 0 → accepted + messageId', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ response_result: [{ response_code: 0, message_id: 'msg-1' }] }),
    );
    const res = await provider.send({
      channel: NotificationChannel.SMS,
      phone: '380671112233',
      message: 'Привіт',
      creds: { apiKey: 'tok', senderName: 'STO' },
    });
    expect(res.accepted).toBe(true);
    expect(res.providerMessageId).toBe('msg-1');
  });

  it('send SMS: response_code != 0 → not accepted + error', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ response_result: [{ response_code: 909, response_status: 'INVALID_TOKEN' }] }),
    );
    const res = await provider.send({
      channel: NotificationChannel.SMS,
      phone: '380671112233',
      message: 'Привіт',
      creds: { apiKey: 'bad' },
    });
    expect(res.accepted).toBe(false);
    expect(res.error).toBe('INVALID_TOKEN');
  });

  it('send VIBER: шле viber-payload (не sms), response_code 0 → accepted', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ response_result: [{ response_code: 0, message_id: 'v-1' }] }),
    );
    const res = await provider.send({
      channel: NotificationChannel.VIBER,
      phone: '380671112233',
      message: 'Привіт у Viber',
      creds: { apiKey: 'tok', senderName: 'STO' },
    });
    expect(res.accepted).toBe(true);
    expect(res.providerMessageId).toBe('v-1');
    // payload містить viber-обʼєкт, а не sms
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.viber).toEqual({ sender: 'STO', text: 'Привіт у Viber' });
    expect(body.sms).toBeUndefined();
  });

  it('send: мережева помилка → accepted:false, error (не кидає)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const res = await provider.send({
      channel: NotificationChannel.SMS,
      phone: '380671112233',
      message: 'x',
      creds: { apiKey: 'tok' },
    });
    expect(res.accepted).toBe(false);
    expect(res.error).toContain('network down');
  });

  it('verifyCredentials: валідний токен → {valid:true, balance}', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ response_code: 0, response_result: { balance: 152.5 } }),
    );
    const res = await provider.verifyCredentials({ apiKey: 'tok' });
    expect(res.valid).toBe(true);
    expect(res.balance).toBe(152.5);
  });

  it('verifyCredentials: невірний токен → {valid:false}', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ response_code: 103, response_status: 'REQUEST_TOKEN_INVALID' }),
    );
    const res = await provider.verifyCredentials({ apiKey: 'bad' });
    expect(res.valid).toBe(false);
    expect(res.error).toBe('REQUEST_TOKEN_INVALID');
  });
});

describe('NotificationProviderRegistry', () => {
  it('get() повертає turbosms/esputnik; невідомий → null; list() без кредів', () => {
    const registry = new NotificationProviderRegistry(
      new TurboSmsProvider(),
      new EsputnikProvider(),
    );
    expect(registry.get('turbosms')?.code).toBe('turbosms');
    expect(registry.get('esputnik')?.code).toBe('esputnik');
    expect(registry.get('nonexistent')).toBeNull();
    const list = registry.list();
    expect(list).toEqual([
      {
        code: 'turbosms',
        name: 'TurboSMS',
        channels: [NotificationChannel.SMS, NotificationChannel.VIBER],
      },
      {
        code: 'esputnik',
        name: 'eSputnik',
        channels: [
          NotificationChannel.SMS,
          NotificationChannel.VIBER,
          NotificationChannel.TELEGRAM,
        ],
      },
    ]);
  });
});
