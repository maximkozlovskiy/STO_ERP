import { vi, describe, it, expect, beforeEach } from 'vitest';
import { NotificationChannel } from '@prisma/client';

// Mock nodemailer до імпорту провайдера.
const sendMail = vi.fn();
const verify = vi.fn();
const close = vi.fn();
const createTransport = vi.fn(() => ({ sendMail, verify, close }));
vi.mock('nodemailer', () => ({ createTransport: (...a: unknown[]) => createTransport(...a) }));

import { EmailProvider } from './email.provider';

/**
 * EmailProvider (SMTP/nodemailer) — SMTP-конфіг JSON у apiKey, send=sendMail, verify=transport.verify,
 * толерантність до невалідного конфігу, помилка не кидає.
 */
describe('EmailProvider', () => {
  let provider: EmailProvider;
  const smtpJson = JSON.stringify({
    host: 'smtp.ukr.net',
    port: 465,
    secure: true,
    user: 'sto@ukr.net',
    pass: 'secret',
  });

  beforeEach(() => {
    provider = new EmailProvider();
    vi.clearAllMocks();
  });

  it('code/name/channels/templateChannels коректні', () => {
    expect(provider.code).toBe('smtp');
    expect(provider.channels).toEqual([NotificationChannel.EMAIL]);
    expect(provider.templateChannels).toEqual([]);
  });

  it('send EMAIL: парсить SMTP-конфіг, шле sendMail з to/subject/text/from', async () => {
    sendMail.mockResolvedValueOnce({ messageId: 'msg-1' });
    const res = await provider.send({
      channel: NotificationChannel.EMAIL,
      recipient: 'client@example.com',
      message: 'Вітаємо!',
      subject: 'Ваш наряд готовий',
      creds: { apiKey: smtpJson, senderName: 'СТО <sto@ukr.net>' },
    });
    expect(res.accepted).toBe(true);
    expect(res.providerMessageId).toBe('msg-1');
    // transport створено з розпарсеного конфігу + таймаутами
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.ukr.net',
        port: 465,
        secure: true,
        auth: { user: 'sto@ukr.net', pass: 'secret' },
        connectionTimeout: 10_000,
      }),
    );
    expect(sendMail).toHaveBeenCalledWith({
      from: 'СТО <sto@ukr.net>',
      to: 'client@example.com',
      subject: 'Ваш наряд готовий',
      text: 'Вітаємо!',
    });
    expect(close).toHaveBeenCalled();
  });

  it('send: from = user якщо senderName відсутній; subject порожній якщо не задано', async () => {
    sendMail.mockResolvedValueOnce({ messageId: 'm' });
    await provider.send({
      channel: NotificationChannel.EMAIL,
      recipient: 'x@y.com',
      message: 'text',
      creds: { apiKey: smtpJson },
    });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'sto@ukr.net', subject: '' }),
    );
  });

  it('send: невалідний JSON-конфіг → accepted:false (не кидає, не шле)', async () => {
    const res = await provider.send({
      channel: NotificationChannel.EMAIL,
      recipient: 'x@y.com',
      message: 'text',
      creds: { apiKey: 'not-json' },
    });
    expect(res.accepted).toBe(false);
    expect(res.error).toContain('SMTP-конфіг');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('send: конфіг без host/user/pass → accepted:false', async () => {
    const res = await provider.send({
      channel: NotificationChannel.EMAIL,
      recipient: 'x@y.com',
      message: 'text',
      creds: { apiKey: JSON.stringify({ host: 'h' }) }, // немає user/pass
    });
    expect(res.accepted).toBe(false);
  });

  it('send: SMTP-помилка → accepted:false (не кидає) + transport.close() (leak-guard)', async () => {
    sendMail.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await provider.send({
      channel: NotificationChannel.EMAIL,
      recipient: 'x@y.com',
      message: 'text',
      creds: { apiKey: smtpJson },
    });
    expect(res.accepted).toBe(false);
    expect(res.error).toContain('ECONNREFUSED');
    // Ресурс-безпека: сокет закрито навіть коли sendMail кинув (finally).
    expect(close).toHaveBeenCalled();
  });

  it('send: не-EMAIL канал → not accepted', async () => {
    const res = await provider.send({
      channel: NotificationChannel.SMS,
      recipient: 'x',
      message: 'm',
      creds: { apiKey: smtpJson },
    });
    expect(res.accepted).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('verifyCredentials: transport.verify OK → valid, balance undefined', async () => {
    verify.mockResolvedValueOnce(true);
    const res = await provider.verifyCredentials({ apiKey: smtpJson });
    expect(res.valid).toBe(true);
    expect(res.balance).toBeUndefined();
    expect(verify).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('verifyCredentials: verify кидає → invalid + transport.close() (leak-guard)', async () => {
    verify.mockRejectedValueOnce(new Error('auth failed'));
    const res = await provider.verifyCredentials({ apiKey: smtpJson });
    expect(res.valid).toBe(false);
    expect(res.error).toContain('auth failed');
    // Ресурс-безпека: сокет закрито навіть коли verify() кинув (finally).
    expect(close).toHaveBeenCalled();
  });

  it('verifyCredentials: невалідний конфіг → invalid без зʼєднання', async () => {
    const res = await provider.verifyCredentials({ apiKey: 'bad' });
    expect(res.valid).toBe(false);
    expect(createTransport).not.toHaveBeenCalled();
  });
});
