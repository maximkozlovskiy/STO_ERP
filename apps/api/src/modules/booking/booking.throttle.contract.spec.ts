import { Reflector } from '@nestjs/core';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { BookingController } from './booking.controller';

/**
 * Contract-тест: public booking endpoints мають мати @Throttle декоратор.
 * Захищає від випадкового видалення декоратора при рефакторингу публічних
 * endpoint-ів (без cap зловмисник може enumerate-ити філії, probing-ити
 * доступність, флудити заявки).
 *
 * Reference: Bug #538/Review Cycle 3 — додано throttle на listPublicBranches,
 * getAvailability, createPublic.
 */
describe('BookingController — @Throttle contract', () => {
  const reflector = new Reflector();

  const cases: { method: string; expectedLimit: number; expectedTtl: number }[] = [
    { method: 'listPublicBranches', expectedLimit: 30, expectedTtl: 60_000 },
    { method: 'getAvailability', expectedLimit: 30, expectedTtl: 60_000 },
    { method: 'createPublic', expectedLimit: 5, expectedTtl: 60_000 },
  ];

  it.each(cases)(
    '$method має @Throttle({ limit: $expectedLimit, ttl: $expectedTtl })',
    ({ method, expectedLimit, expectedTtl }) => {
      const handler = (BookingController.prototype as Record<string, unknown>)[method];
      expect(handler).toBeDefined();

      const limit = reflector.get<number>(`${THROTTLER_LIMIT}default`, handler as never);
      const ttl = reflector.get<number>(`${THROTTLER_TTL}default`, handler as never);

      expect(limit).toBe(expectedLimit);
      expect(ttl).toBe(expectedTtl);
    },
  );

  it('всі публічні endpoints (без JwtAuthGuard) мають @Throttle декоратор', () => {
    // Whitelist методів які НЕ мають guards (публічні)
    const publicMethods = ['listPublicBranches', 'getAvailability', 'createPublic'];

    for (const method of publicMethods) {
      const handler = (BookingController.prototype as Record<string, unknown>)[method];
      expect(handler).toBeDefined();
      const limit = reflector.get<number>(`${THROTTLER_LIMIT}default`, handler as never);
      expect(limit).toBeGreaterThan(0);
    }
  });
});
