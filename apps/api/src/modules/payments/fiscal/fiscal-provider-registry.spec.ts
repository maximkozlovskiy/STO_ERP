import { describe, it, expect, vi } from 'vitest';
import { FiscalProviderRegistry } from './fiscal-provider-registry';
import { CheckboxProvider } from './checkbox.provider';
import { VchasnoProvider } from './vchasno.provider';
import { CheckboxClient, CheckboxUnauthorizedError } from '../checkbox.client';
import { FiscalUnauthorizedError } from './fiscal-provider.interface';

/**
 * Registry провайдерів ПРРО + checkbox/vchasno units.
 * Доводимо: registry.get/list; CheckboxProvider обгортка parity + 401-map; Vchasno SSRF/401.
 */
describe('FiscalProviderRegistry', () => {
  const make = () =>
    new FiscalProviderRegistry(new CheckboxProvider(new CheckboxClient()), new VchasnoProvider());

  it('get() повертає зареєстрований провайдер; невідомий → null', () => {
    const r = make();
    expect(r.get('checkbox')?.code).toBe('checkbox');
    expect(r.get('vchasno')?.code).toBe('vchasno');
    expect(r.get('unknown')).toBeNull();
  });

  it('list() — метадані обох провайдерів без кредів', () => {
    const list = make().list();
    expect(list.map(p => p.code).sort()).toEqual(['checkbox', 'vchasno']);
  });
});

describe('CheckboxProvider (обгортка parity)', () => {
  const cfg = {
    apiUrl: 'https://api.checkbox.ua',
    credentials: { licenseKey: 'LIC', pinCode: 'PIN' },
  };

  it('signIn делегує CheckboxClient.signInPinCode(apiUrl, license, pin)', async () => {
    const client = {
      signInPinCode: vi.fn().mockResolvedValue({ accessToken: 'tok', expiresAt: '2030' }),
    };
    const p = new CheckboxProvider(client as never);
    const tok = await p.signIn(cfg);
    expect(tok).toEqual({ accessToken: 'tok', expiresAt: '2030' });
    expect(client.signInPinCode).toHaveBeenCalledWith('https://api.checkbox.ua', 'LIC', 'PIN');
  });

  it('openShift мапить checkboxShiftId → providerShiftId', async () => {
    const client = { openShift: vi.fn().mockResolvedValue({ checkboxShiftId: 'cbx-9' }) };
    const p = new CheckboxProvider(client as never);
    expect(await p.openShift(cfg, 'tok')).toEqual({ providerShiftId: 'cbx-9' });
  });

  it('sellReceipt делегує клієнту (cfg.apiUrl, token, params)', async () => {
    const client = { sellReceipt: vi.fn().mockResolvedValue({ fiscalReceiptId: 'fr' }) };
    const p = new CheckboxProvider(client as never);
    const r = await p.sellReceipt(cfg, 'tok', { amount: 100, method: 'cash' });
    expect(r).toEqual({ fiscalReceiptId: 'fr' });
    expect(client.sellReceipt).toHaveBeenCalledWith('https://api.checkbox.ua', 'tok', {
      amount: 100,
      method: 'cash',
    });
  });

  it('CheckboxUnauthorizedError → FiscalUnauthorizedError (провайдер-агностичний)', async () => {
    const client = {
      sellReceipt: vi.fn().mockRejectedValue(new CheckboxUnauthorizedError('401')),
    };
    const p = new CheckboxProvider(client as never);
    await expect(p.sellReceipt(cfg, 'tok', { amount: 1, method: 'cash' })).rejects.toBeInstanceOf(
      FiscalUnauthorizedError,
    );
  });

  it('creds без license/pin → кидає', async () => {
    const p = new CheckboxProvider({ signInPinCode: vi.fn() } as never);
    await expect(p.signIn({ apiUrl: null, credentials: {} })).rejects.toThrow(/ключ\/PIN/);
  });

  it('verifyCredentials: успішний signIn → valid; 401 → invalid', async () => {
    const okClient = { signInPinCode: vi.fn().mockResolvedValue({ accessToken: 't' }) };
    expect((await new CheckboxProvider(okClient as never).verifyCredentials(cfg)).valid).toBe(true);
    const badClient = {
      signInPinCode: vi.fn().mockRejectedValue(new CheckboxUnauthorizedError('401')),
    };
    const r = await new CheckboxProvider(badClient as never).verifyCredentials(cfg);
    expect(r.valid).toBe(false);
  });
});

describe('VchasnoProvider', () => {
  const cfg = { apiUrl: 'https://kasa.vchasno.ua', credentials: { token: 'TOK' } };
  const p = new VchasnoProvider();

  it('signIn повертає токен з кредів (без окремого обміну)', async () => {
    expect(await p.signIn(cfg)).toEqual({ accessToken: 'TOK' });
  });

  it('signIn без токена → кидає', async () => {
    await expect(p.signIn({ apiUrl: null, credentials: {} })).rejects.toThrow(/API-токен/);
  });

  // Cloud API v3: тіло `{ fiscal: { task, goods, payment } }`, auth — СИРИЙ токен без Bearer,
  // endpoint /api/v3/fiscal/execute. (Детальний контракт — vchasno.provider.spec.ts.)
  it('sellReceipt: успішна відповідь → fiscalReceiptId (task:1, raw-token) + cents=round(amount*100) без IEEE-754 дрейфу', async () => {
    let sentBody: {
      fiscal: {
        task: number;
        goods: Array<{ price: number }>;
        payment: { type: string; value: number };
      };
    } = { fiscal: { task: -1, goods: [{ price: 0 }], payment: { type: '', value: 0 } } };
    const fetchMock = vi.fn(
      async (url: string, opts: { headers: Record<string, string>; body: string }) => {
        expect(url).toBe('https://kasa.vchasno.ua/api/v3/fiscal/execute');
        expect(opts.headers.Authorization).toBe('TOK'); // сирий токен, НЕ Bearer
        sentBody = JSON.parse(opts.body);
        return { status: 200, ok: true, text: async () => JSON.stringify({ fisn: 'v-fr-1' }) };
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      // 35.20 * 100 = 3520.0000000000005 у сирому JS → Math.round дає 3520 (без дрейфу).
      const r = await p.sellReceipt(cfg, 'TOK', { amount: 35.2, method: 'card_terminal' });
      expect(r.fiscalReceiptId).toBe('v-fr-1');
      expect(sentBody.fiscal.task).toBe(1);
      expect(sentBody.fiscal.goods[0].price).toBe(3520);
      expect(sentBody.fiscal.payment.value).toBe(3520);
      // method != 'cash' → CASHLESS.
      expect(sentBody.fiscal.payment.type).toBe('CASHLESS');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sellReceipt: method=cash → payment.type=CASH', async () => {
    let sentBody: { fiscal: { payment: { type: string } } } = { fiscal: { payment: { type: '' } } };
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      sentBody = JSON.parse(opts.body);
      return { status: 200, ok: true, text: async () => JSON.stringify({ fisn: 'v' }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await p.sellReceipt(cfg, 'TOK', { amount: 10, method: 'cash' });
      expect(sentBody.fiscal.payment.type).toBe('CASH');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('401 → FiscalUnauthorizedError (для re-sign-in у processor)', async () => {
    const fetchMock = vi.fn(async () => ({ status: 401, ok: false, text: async () => 'unauth' }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(p.openShift(cfg, 'TOK')).rejects.toBeInstanceOf(FiscalUnauthorizedError);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('3xx redirect (SSRF-tamper) → кидає', async () => {
    const fetchMock = vi.fn(async () => ({ status: 302, ok: false, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(p.openShift(cfg, 'TOK')).rejects.toThrow(/перенаправлення/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('невалідний apiUrl (loopback) → SSRF-guard кидає, fetch НЕ викликається', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(
        p.openShift({ apiUrl: 'http://169.254.169.254', credentials: cfg.credentials }, 'TOK'),
      ).rejects.toThrow(/Невалідний Вчасно API URL/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
