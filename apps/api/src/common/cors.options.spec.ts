import { describe, it, expect } from 'vitest';
import { Controller, Delete, Module, Patch } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { CORS_OPTIONS, DEV_WEB_ORIGINS, REQUIRED_CORS_METHODS } from './cors.options';

// `origin` — рядок (WEB_ORIGIN заданий) або dev-список; для preflight-проб беремо перший.
const ORIGIN = ([] as string[]).concat(CORS_OPTIONS.origin)[0];

/**
 * Регресія Bug #779 — preflight мусить дозволяти DELETE/PATCH/PUT.
 *
 * На Fastify `enableCors` делегує у `@fastify/cors`, чий дефолт `methods` — ЛИШЕ
 * `GET,HEAD,POST`. Без явного переліку браузер блокував кожен cross-origin
 * `DELETE`/`PATCH`/`PUT` як «TypeError: Failed to fetch», а API-тести цього не бачили:
 * `supertest`/`curl` не роблять preflight узагалі.
 *
 * Тому тут ДВА рівні:
 *  1. статична перевірка самого обʼєкта `CORS_OPTIONS` (швидка, завжди);
 *  2. ЖИВИЙ preflight через справжній Fastify-застосунок із тим самим `enableCors(...)` —
 *     саме він ловить випадок «опція є, але адаптер її проігнорував».
 */
describe('CORS_OPTIONS — Bug #779', () => {
  it('містить усі методи, які має API (GET/POST/PUT/PATCH/DELETE)', () => {
    const methods = CORS_OPTIONS.methods;
    expect(Array.isArray(methods)).toBe(true);
    for (const m of REQUIRED_CORS_METHODS) {
      expect(methods as string[]).toContain(m);
    }
  });

  it('methods заданий ЯВНО (не покладається на дефолт адаптера)', () => {
    // Саме відсутність цього поля була багом: дефолт @fastify/cors = GET,HEAD,POST.
    expect(CORS_OPTIONS.methods).toBeDefined();
  });

  it('credentials увімкнені (refresh-cookie) і preflight кешується', () => {
    expect(CORS_OPTIONS.credentials).toBe(true);
    expect(CORS_OPTIONS.maxAge).toBeGreaterThan(0);
  });
});

@Controller('probe')
class ProbeController {
  @Delete(':id') remove(): { ok: boolean } {
    return { ok: true };
  }
  @Patch(':id') patch(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('CORS — живий preflight через Fastify-адаптер', () => {
  /**
   * Піднімаємо мінімальний Nest+Fastify із ТИМИ САМИМИ CORS_OPTIONS і робимо реальний
   * OPTIONS-запит. Це єдиний спосіб зловити розбіжність «конфіг виглядає правильно, але
   * адаптер віддає інше» — рівно та форма, яку мав Bug #779.
   */
  async function preflight(method: string): Promise<{ status: number; allow: string }> {
    const app = await NestFactory.create<NestFastifyApplication>(
      ProbeModule,
      new FastifyAdapter(),
      {
        logger: false,
      },
    );
    app.enableCors(CORS_OPTIONS);
    await app.init();
    try {
      const res = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'OPTIONS',
          url: '/probe/abc',
          headers: {
            origin: ORIGIN,
            'access-control-request-method': method,
          },
        });
      return {
        status: res.statusCode,
        allow: String(res.headers['access-control-allow-methods'] ?? ''),
      };
    } finally {
      await app.close();
    }
  }

  it.each(['DELETE', 'PATCH', 'PUT'])(
    'preflight для %s повертає цей метод у allow-methods',
    async method => {
      const { status, allow } = await preflight(method);
      expect(status).toBeLessThan(400);
      // Головний інваріант: метод НАЗВАНИЙ у відповіді, інакше браузер заблокує запит.
      expect(allow.toUpperCase()).toContain(method);
    },
  );

  it('allow-methods не звужується до дефолту GET,HEAD,POST', async () => {
    const { allow } = await preflight('DELETE');
    const normalized = allow.toUpperCase().replace(/\s/g, '');
    expect(normalized).not.toBe('GET,HEAD,POST');
  });

  it('origin відбивається у відповіді разом із credentials', async () => {
    const app = await NestFactory.create<NestFastifyApplication>(
      ProbeModule,
      new FastifyAdapter(),
      {
        logger: false,
      },
    );
    app.enableCors(CORS_OPTIONS);
    await app.init();
    try {
      const res = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'OPTIONS',
          url: '/probe/abc',
          headers: {
            origin: ORIGIN,
            'access-control-request-method': 'DELETE',
          },
        });
      expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    } finally {
      await app.close();
    }
  });

  // Локально є два web-сервери: :3001 (dev) і :3002 (Playwright). Якщо E2E-origin випаде
  // зі списку, КОЖЕН запит E2E-сторінки до API заблокує браузер — і весь suite впаде на
  // логіні, не назвавши причину.
  it('dev-fallback дозволяє і dev-сервер (:3001), і E2E-сервер (:3002); чужий origin — ні', async () => {
    const app = await NestFactory.create<NestFastifyApplication>(
      ProbeModule,
      new FastifyAdapter(),
      {
        logger: false,
      },
    );
    app.enableCors({ ...CORS_OPTIONS, origin: DEV_WEB_ORIGINS });
    await app.init();
    try {
      const allowOrigin = async (origin: string) => {
        const res = await app
          .getHttpAdapter()
          .getInstance()
          .inject({
            method: 'OPTIONS',
            url: '/probe/abc',
            headers: { origin, 'access-control-request-method': 'DELETE' },
          });
        return res.headers['access-control-allow-origin'];
      };
      expect(await allowOrigin('http://localhost:3001')).toBe('http://localhost:3001');
      expect(await allowOrigin('http://localhost:3002')).toBe('http://localhost:3002');
      expect(await allowOrigin('http://evil.example')).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
