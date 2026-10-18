import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../redis/redis.constants';
import { SupplierRateLimitError } from './supplier-errors';

const KEY_PREFIX = 'supplier:rl:';
/** Мінімальна пауза після 429 без підказки від постачальника. */
export const DEFAULT_RATE_LIMIT_PAUSE_MS = 60_000;

/**
 * Квота постачальника в Redis на «область» (BR-SCON-007). Постачальник сказав «досить» (429 чи
 * `x-ratelimit-remaining: 0`) — область блокується до скидання квоти, і наступні задачі відкладаються
 * без звернення до мережі й без витрати спроби. Область — підключення; для AVD — спільна для всіх
 * ключів клієнта-контрагента (квоту AVD ділять усі ключі одного клієнта).
 *
 * Redis недоступний — пропускаємо (fail-open): гірше буде лише 429 від постачальника, а він
 * знову ж обробиться як ліміт.
 */
@Injectable()
export class SupplierRateLimiter {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Кидає SupplierRateLimitError, якщо область заблокована. */
  async assertAvailable(scope: string, provider: string): Promise<void> {
    let ttl = -2;
    try {
      ttl = await this.redis.pttl(KEY_PREFIX + scope);
    } catch {
      return;
    }
    if (ttl > 0) {
      throw new SupplierRateLimitError(
        provider,
        `${provider}: вичерпано ліміт запитів, повтор через ${Math.ceil(ttl / 1000)} с`,
        ttl,
        null,
      );
    }
  }

  async block(scope: string, ms: number): Promise<void> {
    const pause = Math.max(1000, Math.round(ms));
    try {
      await this.redis.set(KEY_PREFIX + scope, '1', 'PX', pause);
    } catch {
      // fail-open: див. коментар класу
    }
  }
}
