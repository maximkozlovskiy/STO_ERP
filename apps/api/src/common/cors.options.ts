import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/** Те, чого чекає саме Fastify-адаптер (@fastify/cors не є прямою залежністю). */
type FastifyCorsOptions = Parameters<NestFastifyApplication['enableCors']>[0];

/**
 * CORS-налаштування API — ЄДИНЕ джерело правди (використовує `main.ts`, перевіряє спек).
 *
 * BUG #779: `methods` потрібен ЯВНО. На Fastify `app.enableCors()` делегує у `@fastify/cors`,
 * чий дефолт — лише `GET,HEAD,POST` (на відміну від Express-дефолту з повним набором). Без
 * цього preflight віддавав `access-control-allow-methods: GET,HEAD,POST`, і браузер блокував
 * КОЖЕН cross-origin `DELETE`/`PATCH`/`PUT` як «TypeError: Failed to fetch».
 *
 * Чому не ловилось: API-тести ходять повз CORS (`curl -X DELETE` доходив до guard-а і давав
 * 401), а у проді web — той самий origin за Caddy, тож preflight не потрібен. Видимо лише у
 * cross-origin браузерному сценарії — зловив повний E2E (сторінка :3001 → API :3000).
 *
 * `maxAge`: preflight кешується, тож `OPTIONS` летить максимум раз на 24 год на
 * (origin, path, method, header-set). Chrome обрізає до 7200с, але це все одно краще за
 * відсутність кешу. Виніс сюди разом із `methods`, щоб конфіг не розʼїхався між файлами.
 */
export const CORS_OPTIONS = {
  origin: process.env.WEB_ORIGIN ?? 'http://localhost:3001',
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
  maxAge: 86400,
  // `satisfies`, а не анотація: тип звіряється з тим, чого чекає САМЕ Fastify-адаптер
  // (generic `CorsOptions` із @nestjs/common ширший і не підходить — ще один прояв тієї
  // самої розбіжності Express/Fastify, що й дала Bug #779), але литерал лишається
  // точним, тож `methods` видно як масив рядків, а не як `string[] | undefined`.
} satisfies FastifyCorsOptions;

/** Методи, що МУСЯТЬ бути дозволені — API має роути кожного з них. */
export const REQUIRED_CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
