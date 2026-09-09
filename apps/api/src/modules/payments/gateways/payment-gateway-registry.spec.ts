import { describe, it, expect, vi } from 'vitest';
import { PaymentGatewayRegistry } from './payment-gateway-registry';
import { LiqpayGateway } from './liqpay.gateway';
import { MonobankGateway } from './monobank.gateway';
import { MonobankClient } from '../monobank.client';

/**
 * Registry шлюзів + LiqPay/monobank gateway units.
 * Доводимо: registry.get/list, LiqPay signature+checkout+status-мапінг, monobank-обгортка parity.
 */
describe('PaymentGatewayRegistry', () => {
  const make = () =>
    new PaymentGatewayRegistry([new MonobankGateway(new MonobankClient()), new LiqpayGateway()]);

  it('get() повертає зареєстрований шлюз; невідомий → null (не кидає)', () => {
    const r = make();
    expect(r.get('monobank')?.code).toBe('monobank');
    expect(r.get('liqpay')?.code).toBe('liqpay');
    expect(r.get('unknown')).toBeNull();
  });

  it('list() — метадані обох шлюзів без кредів', () => {
    const list = make().list();
    expect(list.map(g => g.code).sort()).toEqual(['liqpay', 'monobank']);
    expect(JSON.stringify(list)).not.toMatch(/token|privateKey|publicKey/i);
  });
});

describe('LiqpayGateway', () => {
  const gw = new LiqpayGateway();
  const cfg = { apiUrl: null, credentials: { publicKey: 'PUB', privateKey: 'PRIV' } };

  it('createInvoice: checkoutUrl = /api/3/checkout?data=..&signature=.. ; gatewayInvoiceId = reference', async () => {
    const res = await gw.createInvoice(cfg, { amountCents: 12345, reference: 'ref-1' });
    expect(res.gatewayInvoiceId).toBe('ref-1'); // order_id = наш reference
    expect(res.checkoutUrl).toContain('https://www.liqpay.ua/api/3/checkout?data=');
    expect(res.checkoutUrl).toContain('&signature=');
  });

  it('createInvoice: сума конвертується у грн з копійок (2 знаки)', async () => {
    const res = await gw.createInvoice(cfg, { amountCents: 50000, reference: 'r' });
    // декодуємо data з URL → JSON → amount
    const data = new URL(res.checkoutUrl).searchParams.get('data')!;
    const payload = JSON.parse(Buffer.from(decodeURIComponent(data), 'base64').toString());
    expect(payload.amount).toBe('500.00');
    expect(payload.currency).toBe('UAH');
    expect(payload.action).toBe('pay');
    expect(payload.order_id).toBe('r');
  });

  it('signature детермінований і залежить від privateKey', async () => {
    const a = await gw.createInvoice(cfg, { amountCents: 100, reference: 'ref' });
    const b = await gw.createInvoice(cfg, { amountCents: 100, reference: 'ref' });
    const sigA = new URL(a.checkoutUrl).searchParams.get('signature');
    const sigB = new URL(b.checkoutUrl).searchParams.get('signature');
    expect(sigA).toBe(sigB); // однаковий payload+key → однаковий підпис
    const c = await new LiqpayGateway().createInvoice(
      { apiUrl: null, credentials: { publicKey: 'PUB', privateKey: 'OTHER' } },
      { amountCents: 100, reference: 'ref' },
    );
    expect(new URL(c.checkoutUrl).searchParams.get('signature')).not.toBe(sigA);
  });

  it('createInvoice без ключів → кидає', async () => {
    await expect(
      gw.createInvoice({ apiUrl: null, credentials: {} }, { amountCents: 1, reference: 'r' }),
    ).rejects.toThrow(/public\/private/);
  });

  it('getStatus мапить статуси LiqPay у нормалізовані', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ status: 'success' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const r = await gw.getStatus(cfg, 'order-1');
      expect(r.status).toBe('paid');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('getStatus: failure→failed, expired→expired, processing→pending', async () => {
    const cases: Array<[string, string]> = [
      ['failure', 'failed'],
      ['reversed', 'failed'],
      ['expired', 'expired'],
      ['processing', 'pending'],
      ['wait_accept', 'pending'],
    ];
    for (const [raw, expected] of cases) {
      const fetchMock = vi.fn(async () => ({
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ status: raw }),
      }));
      vi.stubGlobal('fetch', fetchMock);
      try {
        const r = await gw.getStatus(cfg, 'o');
        expect(r.status, `${raw}→${expected}`).toBe(expected);
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it('getStatus: 3xx redirect (SSRF-tamper) → кидає', async () => {
    const fetchMock = vi.fn(async () => ({ status: 302, ok: false, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(gw.getStatus(cfg, 'o')).rejects.toThrow(/перенаправлення/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('невалідний apiUrl (loopback) → SSRF-guard кидає, fetch НЕ викликається', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(
        gw.getStatus({ apiUrl: 'http://127.0.0.1', credentials: cfg.credentials }, 'o'),
      ).rejects.toThrow(/Невалідний LiqPay API URL/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('MonobankGateway (обгортка parity)', () => {
  it('createInvoice делегує MonobankClient і мапить pageUrl→checkoutUrl', async () => {
    const client = {
      createInvoice: vi
        .fn()
        .mockResolvedValue({ gatewayInvoiceId: 'gw', pageUrl: 'https://pay.mono/x' }),
      getStatus: vi.fn(),
    };
    const gw = new MonobankGateway(client as never);
    const res = await gw.createInvoice(
      { apiUrl: 'https://api.monobank.ua', credentials: { token: 'T' } },
      { amountCents: 100, reference: 'ref' },
    );
    expect(res.checkoutUrl).toBe('https://pay.mono/x');
    expect(res.gatewayInvoiceId).toBe('gw');
    // token з credentials переданий у клієнт.
    expect(client.createInvoice).toHaveBeenCalledWith('https://api.monobank.ua', 'T', {
      amountCents: 100,
      reference: 'ref',
    });
  });

  it('createInvoice без token у credentials → кидає', async () => {
    const gw = new MonobankGateway({ createInvoice: vi.fn(), getStatus: vi.fn() } as never);
    await expect(
      gw.createInvoice({ apiUrl: null, credentials: {} }, { amountCents: 1, reference: 'r' }),
    ).rejects.toThrow(/X-Token/);
  });
});
