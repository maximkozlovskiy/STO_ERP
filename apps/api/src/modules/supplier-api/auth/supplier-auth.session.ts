import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { PrismaService } from '../../../prisma/prisma.service';
import { REDIS_CLIENT } from '../../../redis/redis.constants';
import type { SupplierConnectionContext } from '../adapters/supplier-adapter.interface';
import { SupplierAuthError } from '../http/supplier-errors';

/** Кеш токена в `SupplierConnection.authState` (шифрується at-rest, ENCRYPTED_FIELDS). */
export interface AuthTokenState {
  accessToken: string;
  refreshToken?: string | null;
  /** ISO-час закінчення дії. */
  expiresAt: string;
}

export interface TokenIssuer {
  login(): Promise<AuthTokenState>;
  /** Оновлення за refresh-токеном (UTR); без нього — повторний логін (AD). */
  refresh?(state: AuthTokenState): Promise<AuthTokenState>;
}

/** Токен вважається простроченим заздалегідь — щоб не віддати той, що спливе в дорозі. */
const EXPIRY_SKEW_MS = 60_000;
const LOCK_TTL_MS = 15_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 250;

/**
 * Сесія авторизації постачальника з JWT (UTR — логін + оновлення, AD — логін), BR-SCON-008.
 *
 * Токен кешується в шифрованому `authState`, тож переживає рестарт і не логіниться на кожен
 * запит. Оновлення серіалізується м'ютексом у Redis на підключення: кілька задач черги з
 * простроченим токеном не логіняться паралельно (UTR інвалідовує попередній refresh-токен).
 * Хто не взяв м'ютекс — чекає, поки переможець запише новий токен. Redis недоступний — без
 * м'ютексу (fail-open: гірше буде лише зайвий логін).
 *
 * `withToken`: 401/403 на запиті з кешованим токеном → ОДНА повторна авторизація й повтор запиту;
 * друга відмова — помилка авторизації (обробник ставить FAILED).
 */
@Injectable()
export class SupplierAuthSession {
  private readonly logger = new Logger(SupplierAuthSession.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async withToken<T>(
    conn: SupplierConnectionContext,
    issuer: TokenIssuer,
    call: (token: string) => Promise<T>,
  ): Promise<T> {
    const token = await this.getToken(conn, issuer, false);
    try {
      return await call(token);
    } catch (e) {
      if (!(e instanceof SupplierAuthError)) throw e;
      const renewed = await this.getToken(conn, issuer, true, token);
      return call(renewed);
    }
  }

  /**
   * Чинний токен. `force` — кешований відхилено постачальником: оновити, якщо в кеші досі
   * саме він (`rejected`); інший — уже оновила сусідня задача, беремо його.
   */
  async getToken(
    conn: SupplierConnectionContext,
    issuer: TokenIssuer,
    force: boolean,
    rejected?: string,
  ): Promise<string> {
    const isUsable = (s: AuthTokenState | null): s is AuthTokenState =>
      !!s && (!force || s.accessToken !== rejected) && isFresh(s);

    const cached = await this.readState(conn);
    if (isUsable(cached)) return cached.accessToken;

    const lockKey = `supplier:auth:${conn.id}`;
    const owner = `${process.pid}:${Math.random().toString(36).slice(2)}`;
    const locked = await this.tryLock(lockKey, owner);
    if (locked === false) {
      // Хтось уже оновлює — чекаємо його результату.
      const deadline = Date.now() + LOCK_WAIT_MS;
      while (Date.now() < deadline) {
        await sleep(LOCK_POLL_MS);
        const s = await this.readState(conn);
        if (isUsable(s)) return s.accessToken;
      }
    }
    try {
      const current = await this.readState(conn);
      if (isUsable(current)) return current.accessToken;
      const next = await this.renew(issuer, current, force);
      await this.writeState(conn, next);
      return next.accessToken;
    } finally {
      if (locked === true) await this.unlock(lockKey, owner);
    }
  }

  /** Скинути кеш токена (зміна кредів). */
  async invalidate(conn: Pick<SupplierConnectionContext, 'id' | 'orgId'>): Promise<void> {
    await this.prisma.supplierConnection.updateMany({
      where: { id: conn.id, orgId: conn.orgId },
      data: { authState: null },
    });
  }

  private async renew(
    issuer: TokenIssuer,
    current: AuthTokenState | null,
    force: boolean,
  ): Promise<AuthTokenState> {
    if (issuer.refresh && current?.refreshToken) {
      try {
        return await issuer.refresh(current);
      } catch (e) {
        // Прострочений чи відкликаний refresh-токен → повний логін; решта помилок — нагору.
        if (!(e instanceof SupplierAuthError)) throw e;
        this.logger.debug(`refresh відхилено (force=${force}) — повторний логін`);
      }
    }
    return issuer.login();
  }

  private async readState(conn: SupplierConnectionContext): Promise<AuthTokenState | null> {
    const row = await this.prisma.supplierConnection.findFirst({
      where: { id: conn.id, orgId: conn.orgId },
      select: { authState: true },
    });
    return parseAuthState(row?.authState ?? null);
  }

  private async writeState(conn: SupplierConnectionContext, state: AuthTokenState): Promise<void> {
    await this.prisma.supplierConnection.updateMany({
      where: { id: conn.id, orgId: conn.orgId },
      data: { authState: JSON.stringify(state) },
    });
  }

  /** true — взяли; false — зайнято; null — Redis недоступний. */
  private async tryLock(key: string, owner: string): Promise<boolean | null> {
    try {
      const res = await this.redis.set(key, owner, 'PX', LOCK_TTL_MS, 'NX');
      return res === 'OK';
    } catch {
      return null;
    }
  }

  private async unlock(key: string, owner: string): Promise<void> {
    try {
      if ((await this.redis.get(key)) === owner) await this.redis.del(key);
    } catch {
      // м'ютекс сам спливе за LOCK_TTL_MS
    }
  }
}

export function parseAuthState(raw: string | null): AuthTokenState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<AuthTokenState>;
    if (typeof v.accessToken !== 'string' || typeof v.expiresAt !== 'string') return null;
    return {
      accessToken: v.accessToken,
      refreshToken: v.refreshToken ?? null,
      expiresAt: v.expiresAt,
    };
  } catch {
    return null;
  }
}

function isFresh(s: AuthTokenState, now = Date.now()): boolean {
  const exp = Date.parse(s.expiresAt);
  return Number.isFinite(exp) && exp - EXPIRY_SKEW_MS > now;
}

/**
 * Час закінчення з JWT (`exp`, секунди) — якщо постачальник не віддає його окремо (AD).
 * Підпис не перевіряється: токен лише пересилається назад тому, хто його видав.
 */
export function jwtExpiresAt(token: string, fallbackMs: number, now = Date.now()): string {
  const part = token.split('.')[1];
  if (part) {
    try {
      const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as {
        exp?: number;
      };
      if (typeof payload.exp === 'number' && payload.exp > 0) {
        return new Date(payload.exp * 1000).toISOString();
      }
    } catch {
      // не JWT чи без exp — fallback нижче
    }
  }
  return new Date(now + fallbackMs).toISOString();
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
