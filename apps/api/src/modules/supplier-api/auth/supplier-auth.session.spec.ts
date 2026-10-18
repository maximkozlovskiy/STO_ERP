import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../prisma/prisma.service';
import { memoryTable } from '../../cash/cash.spec-fixture';
import { brokenRedis, CONN, connectionCtx, fakeRedis, ORG } from '../supplier-api.spec-fixture';
import { SupplierAuthError, SupplierServerError } from '../http/supplier-errors';
import {
  jwtExpiresAt,
  SupplierAuthSession,
  type AuthTokenState,
  type TokenIssuer,
} from './supplier-auth.session';

/**
 * Сесія JWT постачальника (UTR / AD), BR-SCON-008: кеш у authState, оновлення під м'ютексом,
 * одна повторна авторизація на 401. Таблиця підключень у пам'яті виконує `where`.
 */
const future = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

function setup(authState: AuthTokenState | null, redis = fakeRedis()) {
  const table = memoryTable([
    { id: CONN, orgId: ORG, authState: authState ? JSON.stringify(authState) : null },
    { id: 'other-conn', orgId: 'other-org', authState: null },
  ]);
  const prisma = { supplierConnection: table } as unknown as PrismaService;
  return { session: new SupplierAuthSession(prisma, redis), table };
}

function issuer(over: Partial<TokenIssuer> = {}) {
  let n = 0;
  const login = vi.fn(() => {
    n += 1;
    return Promise.resolve({
      accessToken: `login-${n}`,
      refreshToken: `r-${n}`,
      expiresAt: future(30),
    });
  });
  return { login, ...over } as TokenIssuer & { login: typeof login };
}

const conn = connectionCtx('UTR');

describe('SupplierAuthSession — JWT постачальника (BR-SCON-008)', () => {
  // guards: BR-SCON-008
  it('свіжий токен з authState — без логіну', async () => {
    const { session } = setup({ accessToken: 'cached', expiresAt: future(30) });
    const iss = issuer();
    await expect(session.getToken(conn, iss, false)).resolves.toBe('cached');
    expect(iss.login).not.toHaveBeenCalled();
  });

  // guards: BR-SCON-008
  it('прострочений → refresh-токеном (UTR), новий стан записано лише в рядок своєї організації', async () => {
    const { session, table } = setup({
      accessToken: 'old',
      refreshToken: 'r-old',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const refresh = vi.fn((s: AuthTokenState) =>
      Promise.resolve({
        accessToken: `refreshed-from-${s.refreshToken}`,
        refreshToken: 'r2',
        expiresAt: future(30),
      }),
    );
    const iss = issuer({ refresh });
    await expect(session.getToken(conn, iss, false)).resolves.toBe('refreshed-from-r-old');
    expect(iss.login).not.toHaveBeenCalled();
    expect(JSON.parse(table.rows[0].authState as string).accessToken).toBe('refreshed-from-r-old');
    expect(table.rows[1].authState).toBeNull();
  });

  it('refresh відхилено (401) → повний логін', async () => {
    const { session } = setup({
      accessToken: 'old',
      refreshToken: 'r-old',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const iss = issuer({
      refresh: vi.fn(() => Promise.reject(new SupplierAuthError('UTR', 'UTR 401: bad refresh'))),
    });
    await expect(session.getToken(conn, iss, false)).resolves.toBe('login-1');
  });

  it('мережева помилка refresh не маскується логіном — летить нагору (повтор задачі)', async () => {
    const { session } = setup({
      accessToken: 'old',
      refreshToken: 'r-old',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const iss = issuer({
      refresh: vi.fn(() => Promise.reject(new SupplierServerError('UTR', 'UTR 502: x', 502))),
    });
    await expect(session.getToken(conn, iss, false)).rejects.toBeInstanceOf(SupplierServerError);
    expect(iss.login).not.toHaveBeenCalled();
  });

  // guards: BR-SCON-008
  it('401 на запиті → ОДНА повторна авторизація й повтор; друга відмова — помилка авторизації', async () => {
    const { session } = setup({ accessToken: 'cached', expiresAt: future(30) });
    const iss = issuer();
    const call = vi.fn((token: string) =>
      token === 'cached'
        ? Promise.reject(new SupplierAuthError('UTR', 'UTR 401: Expired JWT Token'))
        : Promise.resolve(`ok:${token}`),
    );
    await expect(session.withToken(conn, iss, call)).resolves.toBe('ok:login-1');
    expect(call).toHaveBeenCalledTimes(2);

    const always401 = vi.fn(() => Promise.reject(new SupplierAuthError('UTR', 'UTR 401: no')));
    await expect(session.withToken(conn, iss, always401)).rejects.toBeInstanceOf(SupplierAuthError);
    expect(always401).toHaveBeenCalledTimes(2);
  });

  // guards: BR-SCON-008
  it('дві задачі з простроченим токеном одночасно → один логін (м’ютекс у Redis)', async () => {
    const { session } = setup(null);
    let release: () => void = () => undefined;
    const gate = new Promise<void>(r => (release = r));
    const login = vi.fn(async () => {
      await gate;
      return { accessToken: 'shared', expiresAt: future(30) };
    });
    const iss: TokenIssuer = { login };
    const a = session.getToken(conn, iss, false);
    const b = session.getToken(conn, iss, false);
    await new Promise(r => setTimeout(r, 50));
    release();
    await expect(Promise.all([a, b])).resolves.toEqual(['shared', 'shared']);
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('Redis недоступний → працює без м’ютексу (fail-open)', async () => {
    const { session } = setup(null, brokenRedis() as ReturnType<typeof fakeRedis>);
    await expect(session.getToken(conn, issuer(), false)).resolves.toBe('login-1');
  });

  it('jwtExpiresAt: exp із токена, інакше запасний строк', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_800_000_000 })).toString('base64url');
    expect(jwtExpiresAt(`h.${payload}.s`, 1000)).toBe(new Date(1_800_000_000_000).toISOString());
    const now = Date.parse('2026-10-18T10:00:00Z');
    expect(jwtExpiresAt('not-a-jwt', 60_000, now)).toBe('2026-10-18T10:01:00.000Z');
  });
});
