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

  it('sellReceipt: успішна відповідь → fiscalReceiptId (Bearer=token)', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { headers: Record<string, string> }) => {
      expect(opts.headers.Authorization).toBe('Bearer TOK');
      return { status: 200, ok: true, text: async () => JSON.stringify({ id: 'v-fr-1' }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const r = await p.sellReceipt(cfg, 'TOK', { amount: 250, method: 'card_terminal' });
      expect(r.fiscalReceiptId).toBe('v-fr-1');
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
