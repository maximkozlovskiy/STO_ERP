import 'reflect-metadata';
import { Controller, Get, Injectable } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../app.module';
import { AuthController } from './auth.controller';
import { IS_PUBLIC_KEY, Public } from './decorators/public.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

/**
 * КОНТРАКТ-ТЕСТ «закрито за замовчуванням» (Етап 2 безпекового блоку, рішення власника 2026-10-24).
 *
 * Це головна страховка найризикованішої зміни блоку: `JwtAuthGuard` тепер глобальний (`APP_GUARD`),
 * тож КОЖЕН роут вимагає JWT, доки його явно не позначено `@Public()`. Помилка в будь-який бік
 * фатальна: зайвий `@Public()` на грошовому роуті відкриває його без автентифікації; зникла
 * глобальна реєстрація — закривають вхід/healthcheck.
 *
 * Тест перелічує МЕТАДАНІ всіх зареєстрованих роутів (обхід графа модулів без підняття застосунку —
 * без БД/Redis/черг, тому не flaky) і стверджує: множина `@Public()`-роутів ТОЧНО дорівнює
 * жорстко заданому дозволеному списку. Будь-який новий `@Public()` деінде валить CI.
 */

// ── Дозволений список публічних роутів (ControllerClass::method) ──────────────────────────
// Єдине місце правди для «які роути легітимно неавтентифіковані». Форма — стабільна між
// версіонуванням URI й глобальним префіксом (ідентичність, а не шлях).
const PUBLIC_ALLOWLIST: ReadonlySet<string> = new Set([
  // auth: лише вхід і оновлення токена (logout/me/change-password/logout-all лишаються guarded)
  'AuthController::login',
  'AuthController::refresh',
  // booking: лише публічний блок віджета (авторизований блок із ~114 рядка — guarded)
  'BookingController::listPublicBranches',
  'BookingController::getAvailability',
  'BookingController::createPublic',
  // health: весь контролер (docker healthcheck / installer / e2e-smoke, без JWT)
  'HealthController::live',
  'HealthController::ready',
  'HealthController::check',
  // setup: весь контролер (first-run wizard, до появи org/user)
  'SetupController::status',
  'SetupController::init',
  // публічний перегляд/експорт кошторису за share-токеном (зовнішні SMS/email-лінки)
  'WorkOrdersPublicController::getPublicEstimate',
  'WorkOrdersPublicController::exportPdf',
  'WorkOrdersPublicController::exportXlsx',
  'WorkOrdersPublicController::exportDocx',
]);

type Ctor = new (...args: unknown[]) => unknown;

/**
 * Обхід графа модулів AppModule через метадані декораторів (`@Module`). Нічого не інстанціює:
 * статичні модулі читаються через `Reflect.getMetadata`, динамічні (`.register()`, `.forRootAsync`)
 * — через власні масиви `controllers`/`imports` об'єкта `DynamicModule`.
 */
function collectControllers(root: unknown): Set<Ctor> {
  const seen = new Set<unknown>();
  const controllers = new Set<Ctor>();
  const visit = (node: unknown): void => {
    if (!node) return;
    const isClass = typeof node === 'function';
    const asDynamic = node as { module?: unknown; controllers?: unknown[]; imports?: unknown[] };
    const mod = isClass ? node : asDynamic.module;
    if (mod && !seen.has(mod)) {
      seen.add(mod);
      for (const c of (Reflect.getMetadata('controllers', mod as object) ?? []) as Ctor[]) {
        controllers.add(c);
      }
      for (const i of (Reflect.getMetadata('imports', mod as object) ?? []) as unknown[]) {
        visit(i);
      }
    }
    if (!isClass) {
      for (const c of (asDynamic.controllers ?? []) as Ctor[]) controllers.add(c);
      for (const i of (asDynamic.imports ?? []) as unknown[]) visit(i);
    }
  };
  visit(root);
  return controllers;
}

/** HTTP-методи контролера (ті, що мають METHOD_METADATA від @Get/@Post/…). */
function httpHandlers(ctrl: Ctor): string[] {
  const proto = (ctrl as { prototype: Record<string, unknown> }).prototype;
  return Object.getOwnPropertyNames(proto).filter(name => {
    if (name === 'constructor') return false;
    const value = proto[name];
    return typeof value === 'function' && Reflect.hasMetadata(METHOD_METADATA, value);
  });
}

function hasJwtGuard(guards: unknown): boolean {
  return Array.isArray(guards) && guards.some(g => g === JwtAuthGuard || g instanceof JwtAuthGuard);
}

describe('Глобальний guard «закрито за замовчуванням» — контракт', () => {
  const reflector = new Reflector();
  const controllers = collectControllers(AppModule);

  it('знаходить усі контролери через метадані (без підняття застосунку)', () => {
    // Якщо обхід раптом перестане бачити модулі — порожній/крихітний набір зробив би всі
    // наступні assert-и беззмістовними. Межа консервативна (реально ~83).
    expect(controllers.size).toBeGreaterThan(50);
  });

  it('множина @Public()-роутів ТОЧНО дорівнює дозволеному списку', () => {
    const publicRoutes = new Set<string>();
    for (const ctrl of controllers) {
      for (const method of httpHandlers(ctrl)) {
        const handler = (ctrl as { prototype: Record<string, unknown> }).prototype[method];
        const isPublic = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
          handler as never,
          ctrl as never,
        ]);
        if (isPublic) publicRoutes.add(`${(ctrl as Ctor).name}::${method}`);
      }
    }

    const unexpected = [...publicRoutes].filter(r => !PUBLIC_ALLOWLIST.has(r)).sort();
    const missing = [...PUBLIC_ALLOWLIST].filter(r => !publicRoutes.has(r)).sort();

    // Зайвий @Public() (напр. на грошовому/FSM-роуті) → unexpected не порожній → провал у CI.
    expect(unexpected, `Несанкціоновані @Public()-роути: ${unexpected.join(', ')}`).toEqual([]);
    // Зникла позначка на легітимному публічному роуті → missing не порожній → провал.
    expect(missing, `Загублені @Public()-роути: ${missing.join(', ')}`).toEqual([]);
  });

  it('кожен роут або @Public, або покритий JwtAuthGuard (глобально чи через @UseGuards)', () => {
    // Глобальний JwtAuthGuard покриває ВСЕ, тож роут «відкритий» лише коли він @Public. Але ми
    // додатково стверджуємо, що жоден роут не лишився з «дірою в задумі»: він або у дозволеному
    // списку, або (навіть без глобального guard) має явний per-controller @UseGuards(JwtAuthGuard).
    const openHoles: string[] = [];
    for (const ctrl of controllers) {
      const classGuards: unknown = Reflect.getMetadata(GUARDS_METADATA, ctrl as object);
      for (const method of httpHandlers(ctrl)) {
        const handler = (ctrl as { prototype: Record<string, unknown> }).prototype[method];
        const id = `${(ctrl as Ctor).name}::${method}`;
        const isPublic = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
          handler as never,
          ctrl as never,
        ]);
        if (isPublic) continue;
        const methodGuards: unknown = Reflect.getMetadata(GUARDS_METADATA, handler as object);
        const coveredByGlobal = jwtIsGlobalAppGuard();
        if (!coveredByGlobal && !hasJwtGuard(classGuards) && !hasJwtGuard(methodGuards)) {
          openHoles.push(id);
        }
      }
    }
    expect(openHoles, `Незахищені не-@Public роути: ${openHoles.join(', ')}`).toEqual([]);
  });

  it('JwtAuthGuard зареєстрований глобально (APP_GUARD) — guard активний', () => {
    expect(jwtIsGlobalAppGuard()).toBe(true);
  });

  it('ThrottlerGuard зареєстрований ПЕРЕД JwtAuthGuard (throttle діє на @Public роути)', () => {
    const order = appGuardOrder();
    const throttlerIdx = order.indexOf('ThrottlerGuard');
    const jwtIdx = order.indexOf('JwtAuthGuard');
    expect(throttlerIdx).toBeGreaterThanOrEqual(0);
    expect(jwtIdx).toBeGreaterThanOrEqual(0);
    // Порядок виконання APP_GUARD = порядок реєстрації провайдерів.
    expect(throttlerIdx).toBeLessThan(jwtIdx);
  });

  it('login і refresh лишаються throttled (ліміт зберігся при зміні на @Public)', () => {
    const proto = AuthController.prototype as unknown as Record<string, unknown>;
    const login = proto.login;
    const refresh = proto.refresh;
    const loginLimit = reflector.get<number>(`${THROTTLER_LIMIT}default`, login as never);
    const loginTtl = reflector.get<number>(`${THROTTLER_TTL}default`, login as never);
    const refreshLimit = reflector.get<number>(`${THROTTLER_LIMIT}default`, refresh as never);
    const refreshTtl = reflector.get<number>(`${THROTTLER_TTL}default`, refresh as never);
    expect(loginLimit).toBe(10);
    expect(loginTtl).toBe(60_000);
    // L2: @SkipThrottle прибрано, явний ліміт 30/хв.
    expect(refreshLimit).toBe(30);
    expect(refreshTtl).toBe(60_000);
  });
});

function appGuardOrder(): string[] {
  const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as Array<{
    provide?: unknown;
    useClass?: { name?: string };
  }>;
  return providers.filter(p => p && p.provide === APP_GUARD).map(p => p.useClass?.name ?? '');
}

function jwtIsGlobalAppGuard(): boolean {
  const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as Array<{
    provide?: unknown;
    useClass?: unknown;
  }>;
  return providers.some(p => p && p.provide === APP_GUARD && p.useClass === JwtAuthGuard);
}

// ── Smoke-тест реальної поведінки: 401 на захищений роут, НЕ-401 на @Public ───────────────
// Мінімальний застосунок із РЕАЛЬНИМ JwtAuthGuard як глобальним APP_GUARD і РЕАЛЬНОЮ passport-jwt
// стратегією 'jwt' (локальний секрет, без БД — validate лише повертає payload). Доводить:
// (а) глобальний guard справді блокує неавтентифікований доступ (401); (б) @Public обходить його.
const TEST_JWT_SECRET = 'test-global-guard-secret';

@Injectable()
class SmokeJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: TEST_JWT_SECRET,
    });
  }
  validate(payload: { sub: string }): { id: string } {
    return { id: payload.sub };
  }
}

@Controller('protected-sample')
class ProtectedSampleController {
  @Get()
  get(): { ok: boolean } {
    return { ok: true };
  }
}

@Controller('public-sample')
class PublicSampleController {
  @Get()
  @Public()
  get(): { ok: boolean } {
    return { ok: true };
  }
}

describe('Глобальний guard — жива поведінка (smoke)', () => {
  let app: NestFastifyApplication;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret: TEST_JWT_SECRET }),
      ],
      controllers: [ProtectedSampleController, PublicSampleController],
      providers: [SmokeJwtStrategy, { provide: APP_GUARD, useClass: JwtAuthGuard }],
    }).compile();
    token = moduleRef.get(JwtService).sign({ sub: 'u1' });
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('неавтентифікований запит до захищеного роута → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected-sample' });
    expect(res.statusCode).toBe(401);
  });

  it('автентифікований запит до захищеного роута → не 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected-sample',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).not.toBe(401);
  });

  it('@Public роут без токена → не 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/public-sample' });
    expect(res.statusCode).not.toBe(401);
  });
});
