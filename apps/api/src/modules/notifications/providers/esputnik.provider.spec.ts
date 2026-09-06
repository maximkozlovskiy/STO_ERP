import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NotificationChannel } from '@prisma/client';
import { EsputnikProvider } from './esputnik.provider';

/**
 * eSputnik provider — SMS ad-hoc (sendsms), Viber/Telegram лише через externalTemplateId
 * (smartsend), verifyCredentials (account/info), Basic-auth header, мережеві помилки.
 */
describe('EsputnikProvider', () => {
  let provider: EsputnikProvider;
  const fetchMock = vi.fn();

  beforeEach(() => {
    provider = new EsputnikProvider();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  const okResponse = (json: unknown) =>
    ({ ok: true, text: async () => JSON.stringify(json) }) as Response;

  it('канали = SMS, VIBER, TELEGRAM', () => {
    expect(provider.channels).toEqual([
      NotificationChannel.SMS,
      NotificationChannel.VIBER,
      NotificationChannel.TELEGRAM,
    ]);
  });

  it('send SMS: sendsms inline text → accepted + Basic auth', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ id: 'sms-1' }));
    const res = await provider.send({
      channel: NotificationChannel.SMS,
      phone: '380671112233',
      message: 'Привіт',
      creds: { apiKey: 'tok', senderName: 'STO' },
    });
    expect(res.accepted).toBe(true);
    expect(res.providerMessageId).toBe('sms-1');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/message/sendsms');
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({ from: 'STO', text: 'Привіт', phoneNumbers: ['380671112233'] });
    // Basic auth: base64('api:tok')
    expect(opts.headers.Authorization).toBe(`Basic ${Buffer.from('api:tok').toString('base64')}`);
  });

  it('send VIBER без externalTemplateId → not accepted, fetch НЕ викликано', async () => {
    const res = await provider.send({
      channel: NotificationChannel.VIBER,
      phone: '380671112233',
      message: 'x',
      creds: { apiKey: 'tok' },
    });
    expect(res.accepted).toBe(false);
    expect(res.error).toContain('шаблону');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('send VIBER з externalTemplateId → smartsend {id} + recipients locator', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ id: 'v-1' }));
    const res = await provider.send({
      channel: NotificationChannel.VIBER,
      phone: '380671112233',
      message: 'ignored-inline',
      creds: { apiKey: 'tok' },
      externalTemplateId: 'tpl-42',
    });
    expect(res.accepted).toBe(true);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/message/tpl-42/smartsend');
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({ recipients: [{ locator: '380671112233' }] });
  });

  it('send TELEGRAM з externalTemplateId → smartsend', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ id: 't-1' }));
    const res = await provider.send({
      channel: NotificationChannel.TELEGRAM,
      phone: '380671112233',
      message: 'x',
      creds: { apiKey: 'tok' },
      externalTemplateId: 'tpl-9',
    });
    expect(res.accepted).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/message/tpl-9/smartsend');
  });

  it('send: non-2xx → not accepted (не кидає)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as Response);
    const res = await provider.send({
      channel: NotificationChannel.SMS,
      phone: '380671112233',
      message: 'x',
      creds: { apiKey: 'bad' },
    });
    expect(res.accepted).toBe(false);
    expect(res.error).toContain('401');
  });

  it('send: мережева помилка → accepted:false (не кидає)', async () => {
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

  it('verifyCredentials: account/info 2xx → valid + balance', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ organisationName: 'STO', balance: 250.5 }));
    const res = await provider.verifyCredentials({ apiKey: 'tok' });
    expect(res.valid).toBe(true);
    expect(res.balance).toBe(250.5);
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/account/info');
  });

  it('verifyCredentials: 401 → invalid', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'bad token',
    } as Response);
    const res = await provider.verifyCredentials({ apiKey: 'bad' });
    expect(res.valid).toBe(false);
    expect(res.error).toContain('401');
  });
});
