import { describe, it, expect, vi } from 'vitest';
import { DeliveryProviderRegistry } from './delivery-provider-registry';
import { NovaPoshtaProvider } from './nova-poshta.provider';
import { NovaPoshtaClient } from './nova-poshta.client';

/**
 * Registry служб доставки + Нова Пошта client/provider units.
 * Доводимо: registry get/list; NovaPoshtaClient (SSRF/3xx/timeout/JSON-shape); mapStatus усіх кодів.
 */
describe('DeliveryProviderRegistry', () => {
  const make = () => new DeliveryProviderRegistry(new NovaPoshtaProvider(new NovaPoshtaClient()));

  it('get() повертає зареєстровану службу; невідома → null', () => {
    const r = make();
    expect(r.get('novaposhta')?.code).toBe('novaposhta');
    expect(r.get('unknown')).toBeNull();
  });

  it('list() — метадані без кредів', () => {
    const list = make().list();
    expect(list).toEqual([{ code: 'novaposhta', name: 'Нова Пошта' }]);
  });
});

describe('NovaPoshtaClient', () => {
  const client = new NovaPoshtaClient();
  const cfgUrl = 'https://api.novaposhta.ua';

  it('getStatusDocument: success → statusCode+status; тіло POST /v2.0/json/ з apiKey/model', async () => {
    const fetchMock = vi.fn(async (url: string, opts: { body: string }) => {
      expect(url).toBe('https://api.novaposhta.ua/v2.0/json/');
      const body = JSON.parse(opts.body);
      expect(body.apiKey).toBe('KEY');
      expect(body.modelName).toBe('TrackingDocument');
      expect(body.calledMethod).toBe('getStatusDocuments');
      expect(body.methodProperties.Documents[0].DocumentNumber).toBe('204...');
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({ success: true, data: [{ StatusCode: '7', Status: 'Прибув' }] }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const r = await client.getStatusDocument(cfgUrl, 'KEY', '204...');
      expect(r).toEqual({ statusCode: '7', status: 'Прибув' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('порожній data (success:true) → statusCode 3 (не знайдено)', async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ success: true, data: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const r = await client.getStatusDocument(cfgUrl, 'KEY', 'x');
      expect(r.statusCode).toBe('3');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('success:false → кидає з текстом errors', async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ success: false, errors: ['API key expired'] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(client.getStatusDocument(cfgUrl, 'BAD', 'x')).rejects.toThrow(/API key expired/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('3xx redirect (SSRF-tamper) → кидає', async () => {
    const fetchMock = vi.fn(async () => ({ status: 302, ok: false, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(client.getStatusDocument(cfgUrl, 'K', 'x')).rejects.toThrow(/перенаправлення/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('невалідний apiUrl (loopback) → SSRF-guard кидає, fetch НЕ викликається', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(client.getStatusDocument('http://127.0.0.1', 'K', 'x')).rejects.toThrow(
        /Невалідний Нова Пошта API URL/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('non-ok відповідь → кидає зі статусом', async () => {
    const fetchMock = vi.fn(async () => ({ status: 500, ok: false, text: async () => 'boom' }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(client.getStatusDocument(cfgUrl, 'K', 'x')).rejects.toThrow(/Нова Пошта 500/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('NovaPoshtaProvider.mapStatus', () => {
  const provider = new NovaPoshtaProvider(new NovaPoshtaClient());
  const cfg = { apiUrl: null, credentials: { apiKey: 'K' } };

  const cases: Array<[string, string]> = [
    ['1', 'PENDING'],
    ['2', 'RETURNED'],
    ['3', 'NOT_FOUND'],
    ['4', 'IN_TRANSIT'],
    ['5', 'IN_TRANSIT'],
    ['6', 'IN_TRANSIT'],
    ['41', 'IN_TRANSIT'],
    ['7', 'ARRIVED'],
    ['8', 'ARRIVED'],
    ['9', 'DELIVERED'],
    ['10', 'DELIVERED'],
    ['11', 'DELIVERED'],
    ['103', 'RETURNED'],
    ['105', 'RETURNED'],
    ['999', 'IN_TRANSIT'], // невідомий → не термінальний
  ];

  for (const [code, expected] of cases) {
    it(`StatusCode ${code} → ${expected}`, async () => {
      const fetchMock = vi.fn(async () => ({
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({ success: true, data: [{ StatusCode: code, Status: 'txt' }] }),
      }));
      vi.stubGlobal('fetch', fetchMock);
      try {
        const r = await provider.getStatus(cfg, 'ttn');
        expect(r.status).toBe(expected);
        expect(r.raw).toBe('txt');
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }

  it('getStatus без apiKey → кидає', async () => {
    await expect(provider.getStatus({ apiUrl: null, credentials: {} }, 'ttn')).rejects.toThrow(
      /API-ключ/,
    );
  });

  it('verifyCredentials: валідна відповідь → valid:true', async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ success: true, data: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect((await provider.verifyCredentials(cfg)).valid).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('verifyCredentials: помилка ключа → valid:false', async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ success: false, errors: ['API key not found'] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const r = await provider.verifyCredentials(cfg);
      expect(r.valid).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
