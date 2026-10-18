/**
 * Спільне для спеків supplier-api: Redis у пам'яті (квота, м'ютекс авторизації), справжній
 * HTTP-клієнт із політикою адрес, що дозволяє фейковий сервер, контекст підключення.
 * Factory, не const (isolate:false — module-level стан тік би між файлами).
 */
import type Redis from 'ioredis';
import type { SupplierProvider } from '@prisma/client';
import { SupplierHttpClient } from './http/supplier-http.client';
import { SupplierRateLimiter } from './http/supplier-rate-limiter';
import { SupplierUrlPolicy } from './http/supplier-url-policy';
import type { SupplierConnectionContext } from './adapters/supplier-adapter.interface';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const CONN = '71111111-1111-4111-8111-111111111111';
export const SUPPLIER_CP = '51111111-1111-4111-8111-222222222222';
export const OUR_WH = '21111111-1111-4111-8111-111111111111';

/** Redis у пам'яті: set (PX, NX), get, del, pttl — те, чим користуються квота й м'ютекс. */
export function fakeRedis(now: () => number = () => Date.now()) {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const alive = (k: string) => {
    const e = store.get(k);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= now()) {
      store.delete(k);
      return null;
    }
    return e;
  };
  const api = {
    store,
    set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
      let px: number | null = null;
      let nx = false;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === 'PX') px = Number(args[++i]);
        else if (args[i] === 'NX') nx = true;
      }
      if (nx && alive(key)) return Promise.resolve(null);
      store.set(key, { value, expiresAt: px !== null ? now() + px : null });
      return Promise.resolve('OK');
    },
    get(key: string): Promise<string | null> {
      return Promise.resolve(alive(key)?.value ?? null);
    },
    del(key: string): Promise<number> {
      return Promise.resolve(store.delete(key) ? 1 : 0);
    },
    pttl(key: string): Promise<number> {
      const e = alive(key);
      if (!e) return Promise.resolve(-2);
      return Promise.resolve(e.expiresAt === null ? -1 : e.expiresAt - now());
    },
  };
  return api as typeof api & Redis;
}

/** Redis, що завжди падає — перевірка fail-open. */
export function brokenRedis(): Redis {
  const fail = () => Promise.reject(new Error('Redis недоступний'));
  return { set: fail, get: fail, del: fail, pttl: fail } as unknown as Redis;
}

/** Справжній HTTP-клієнт; фейковий сервер дозволено allowlist-ом (як SUPPLIER_API_DEV_ALLOWED_ORIGINS). */
export function httpClient(allowedOrigins: string[], redis: Redis = fakeRedis()) {
  const policy = SupplierUrlPolicy.fromEnv({
    NODE_ENV: 'test',
    SUPPLIER_API_DEV_ALLOWED_ORIGINS: allowedOrigins.join(','),
  });
  const limiter = new SupplierRateLimiter(redis);
  return { client: new SupplierHttpClient(policy, limiter), limiter, redis };
}

export function connectionCtx(
  provider: SupplierProvider,
  over: Partial<SupplierConnectionContext> = {},
): SupplierConnectionContext {
  return {
    id: CONN,
    orgId: ORG,
    counterpartyId: SUPPLIER_CP,
    provider,
    apiUrl: null,
    testMode: false,
    credentials: {},
    options: {},
    ...over,
  };
}
