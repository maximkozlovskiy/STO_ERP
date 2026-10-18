import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeRedis, httpClient } from '../supplier-api.spec-fixture';
import {
  SupplierAuthError,
  SupplierNetworkError,
  SupplierProtocolError,
  SupplierRateLimitError,
  SupplierServerError,
} from './supplier-errors';
import { buildUrl, retryAfterMs } from './supplier-http.client';

/**
 * HTTP-клієнт постачальників зі СПРАВЖНІМ fetch проти локального сервера на порту 0:
 * класифікація відповідей, тайм-аут, перенаправлення, секрети в тексті, квота (BR-SCON-005, 007).
 */
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

describe('SupplierHttpClient — справжній fetch проти локального сервера', () => {
  let server: Server;
  let base: string;
  let handler: Handler = (_req, res) => res.end('{}');

  beforeAll(async () => {
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  });

  const reply =
    (status: number, body: string, headers: Record<string, string> = {}): Handler =>
    (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body);
    };

  it('2xx JSON → дані; query з масивом і заголовки доходять', async () => {
    let seen: { url?: string; key?: string } = {};
    handler = (req, res) => {
      seen = { url: req.url, key: req.headers['x-api-key'] as string };
      reply(200, '{"ok":true}')(req, res);
    };
    const { client } = httpClient([base]);
    const r = await client.request<{ ok: boolean }>({
      provider: 'AVD',
      baseUrl: `${base}/api/v1/`,
      method: 'GET',
      path: '/items',
      query: { warehouses: ['a', 'b'], empty: '', q: 'OC 90' },
      headers: { 'x-api-key': 'k-123' },
    });
    expect(r.data).toEqual({ ok: true });
    expect(seen.url).toBe('/api/v1/items?warehouses=a&warehouses=b&q=OC+90');
    expect(seen.key).toBe('k-123');
  });

  // guards: BR-SCON-005
  it('адреса не з allowlist і не публічна (localhost) → відмова ДО запиту', async () => {
    let called = false;
    handler = (req, res) => {
      called = true;
      reply(200, '{}')(req, res);
    };
    const { client } = httpClient([]); // allowlist порожній
    await expect(
      client.request({ provider: 'AVD', baseUrl: base, method: 'GET', path: '/x' }),
    ).rejects.toBeInstanceOf(SupplierProtocolError);
    expect(called).toBe(false);
  });

  // guards: BR-SCON-005
  it('401/403 → помилка авторизації з текстом «<провайдер> <статус>:» і без секрету', async () => {
    handler = reply(401, '{"message":"bad token SECRET-TOKEN-1"}');
    const { client } = httpClient([base]);
    const err = await client
      .request({
        provider: 'UTR',
        baseUrl: base,
        method: 'POST',
        path: '/login',
        body: { password: 'SECRET-TOKEN-1' },
        secrets: ['SECRET-TOKEN-1'],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierAuthError);
    expect((err as Error).message).toMatch(/^UTR 401: /);
    expect((err as Error).message).not.toContain('SECRET-TOKEN-1');
    expect((err as SupplierAuthError).retryable).toBe(false);
  });

  // guards: BR-SCON-007
  it('429 з Retry-After → ліміт із паузою; область квоти блокується, наступний запит не йде в мережу', async () => {
    let calls = 0;
    handler = (req, res) => {
      calls += 1;
      reply(429, '{"error":"RATE_LIMIT_EXCEEDED"}', { 'retry-after': '7' })(req, res);
    };
    const redis = fakeRedis();
    const { client } = httpClient([base], redis);
    const req = {
      provider: 'AVD',
      baseUrl: base,
      method: 'GET' as const,
      path: '/items',
      rateScope: 'avd:test',
    };
    const err = await client.request(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierRateLimitError);
    expect((err as SupplierRateLimitError).retryAfterMs).toBe(7000);
    expect((err as SupplierRateLimitError).ambiguous).toBe(false);
    const second = await client.request(req).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(SupplierRateLimitError);
    expect(calls).toBe(1);
  });

  // guards: BR-SCON-007
  it('x-ratelimit-remaining: 0 на успішній відповіді → область блокується на x-ratelimit-reset', async () => {
    handler = reply(200, '{}', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '12' });
    const redis = fakeRedis();
    const { client } = httpClient([base], redis);
    await client.request({
      provider: 'AVD',
      baseUrl: base,
      method: 'GET',
      path: '/a',
      rateScope: 's1',
    });
    const ttl = await redis.pttl('supplier:rl:s1');
    expect(ttl).toBeGreaterThan(11_000);
    expect(ttl).toBeLessThanOrEqual(12_000);
  });

  it('статус ліміту постачальника, відмінний від 429 (Tehnomir 503), → теж ліміт', async () => {
    handler = reply(503, 'Exceeded the allowable limit of requests');
    const { client } = httpClient([base]);
    const err = await client
      .request({
        provider: 'Tehnomir',
        baseUrl: base,
        method: 'POST',
        path: '/p',
        rateLimitStatuses: [503],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierRateLimitError);
  });

  // guards: BR-SCON-011
  it('5xx → повторювана й неоднозначна помилка сервера', async () => {
    handler = reply(502, 'bad gateway');
    const { client } = httpClient([base]);
    const err = await client
      .request({ provider: 'AD', baseUrl: base, method: 'POST', path: '/order' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierServerError);
    expect((err as SupplierServerError).retryable).toBe(true);
    expect((err as SupplierServerError).ambiguous).toBe(true);
    expect((err as Error).message).toBe('AD 502: bad gateway');
  });

  it('4xx (не 401/403/429) → протокольна, не повторювана', async () => {
    handler = reply(422, '{"error":"validation"}');
    const { client } = httpClient([base]);
    const err = await client
      .request({ provider: 'BM Parts', baseUrl: base, method: 'GET', path: '/x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierProtocolError);
    expect((err as SupplierProtocolError).retryable).toBe(false);
  });

  // guards: BR-SCON-005
  it('перенаправлення не виконується (redirect: manual) → протокольна помилка', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      res.end();
    };
    const { client } = httpClient([base]);
    const err = await client
      .request({ provider: 'AVD', baseUrl: base, method: 'GET', path: '/r' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierProtocolError);
    expect((err as Error).message).toContain('302');
  });

  // guards: BR-SCON-011
  it('тайм-аут → мережева неоднозначна помилка', async () => {
    handler = () => undefined; // не відповідає
    const { client } = httpClient([base]);
    const err = await client
      .request({ provider: 'UTR', baseUrl: base, method: 'POST', path: '/order', timeoutMs: 150 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierNetworkError);
    expect((err as SupplierNetworkError).ambiguous).toBe(true);
  });

  it('з’єднання відхилено (порт закритий) → мережева, запит НЕ дійшов (не ambiguous)', async () => {
    const closed = createServer();
    await new Promise<void>(r => closed.listen(0, '127.0.0.1', () => r()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>(r => closed.close(() => r()));
    const { client } = httpClient([`http://127.0.0.1:${port}`]);
    const err = await client
      .request({ provider: 'AVD', baseUrl: `http://127.0.0.1:${port}`, method: 'GET', path: '/x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierNetworkError);
    expect((err as SupplierNetworkError).ambiguous).toBe(false);
  });

  it('2xx не JSON → протокольна неоднозначна (дія могла виконатись)', async () => {
    handler = reply(200, '<html>oops</html>');
    const { client } = httpClient([base]);
    const err = await client
      .request({ provider: 'AVD', baseUrl: base, method: 'POST', path: '/checkout' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierProtocolError);
    expect((err as SupplierProtocolError).ambiguous).toBe(true);
  });

  // guards: BR-SCON-011
  it('заголовки прийшли, тіло «висить» — тайм-аут діє й на читання тіла (неоднозначна)', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"ok":'); // тіло так і не закінчується
    };
    const { client } = httpClient([base]);
    const started = Date.now();
    const err = await client
      .request({
        provider: 'AVD',
        baseUrl: base,
        method: 'POST',
        path: '/checkout',
        timeoutMs: 200,
      })
      .catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(err).toBeInstanceOf(SupplierNetworkError);
    expect((err as SupplierNetworkError).ambiguous).toBe(true);
  });

  // guards: BR-SCON-011
  it('2xx з обірваним тілом — не «успіх з {}», а мережева неоднозначна', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      res.write('{"data":');
      setTimeout(() => res.destroy(), 20);
    };
    const { client } = httpClient([base]);
    const err = await client
      .request({ provider: 'AVD', baseUrl: base, method: 'POST', path: '/checkout' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierNetworkError);
    expect((err as SupplierNetworkError).ambiguous).toBe(true);
  });

  it('тіло понад maxBodyBytes → протокольна помилка, не читається до кінця', async () => {
    handler = reply(200, JSON.stringify({ blob: 'x'.repeat(5000) }));
    const { client } = httpClient([base]);
    const err = await client
      .request({ provider: 'AVD', baseUrl: base, method: 'GET', path: '/big', maxBodyBytes: 1000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierProtocolError);
    expect((err as Error).message).toMatch(/завелика/);
  });

  // guards: BR-SCON-007
  it('статус ліміту з rateLimitBodyPattern: ліміт лише коли тіло відповідає шаблону', async () => {
    const { client } = httpClient([base]);
    const req = {
      provider: 'Tehnomir',
      baseUrl: base,
      method: 'POST' as const,
      path: '/x',
      rateLimitStatuses: [503],
      rateLimitBodyPattern: /limit/i,
    };
    handler = reply(503, '{"success":false,"message":"Exceeded the allowable limit of requests"}');
    await expect(client.request(req)).rejects.toBeInstanceOf(SupplierRateLimitError);
    handler = reply(503, '{"success":false,"message":"Service Unavailable"}');
    await expect(client.request(req)).rejects.toBeInstanceOf(SupplierServerError);
  });
});

describe('buildUrl / retryAfterMs', () => {
  it('buildUrl зшиває базу й шлях без подвійних слешів', () => {
    expect(buildUrl('https://a.b/api/v1/', 'items', { page: 2 })).toBe(
      'https://a.b/api/v1/items?page=2',
    );
  });

  it('Retry-After як HTTP-дата і як x-ratelimit-reset', () => {
    const now = Date.parse('2026-10-18T10:00:00Z');
    expect(retryAfterMs(new Headers({ 'retry-after': 'Sun, 18 Oct 2026 10:00:30 GMT' }), now)).toBe(
      30_000,
    );
    expect(retryAfterMs(new Headers({ 'x-ratelimit-reset': '5' }), now)).toBe(5000);
    expect(retryAfterMs(new Headers({}), now)).toBeNull();
  });

  // guards: BR-SCON-007
  it('x-ratelimit-reset як epoch (секунди / мс) — різниця з now; пауза не довша за годину', () => {
    const now = Date.parse('2026-10-18T10:00:00Z');
    const inSecs = String(Math.floor(now / 1000) + 90);
    expect(retryAfterMs(new Headers({ 'x-ratelimit-reset': inSecs }), now)).toBe(90_000);
    expect(retryAfterMs(new Headers({ 'x-ratelimit-reset': String(now + 45_000) }), now)).toBe(
      45_000,
    );
    expect(retryAfterMs(new Headers({ 'retry-after': '864000' }), now)).toBe(3_600_000);
    expect(retryAfterMs(new Headers({ 'x-ratelimit-reset': '999999' }), now)).toBe(3_600_000);
    expect(retryAfterMs(new Headers({ 'retry-after': 'Sun, 25 Oct 2026 10:00:00 GMT' }), now)).toBe(
      3_600_000,
    );
  });
});
