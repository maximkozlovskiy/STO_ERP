/**
 * HTTP-контракт `POST /payments/:id/reverse` — сторно безготівкової оплати (BR-PAY-024):
 * ролі OWNER / ADMIN / ACCOUNTANT (справжній RolesGuard за метаданими @Roles), причина за спільною
 * `paymentReversalSchema` (обов'язкова, до 500 символів, обрізається), id — UUID, маршрут несе
 * RequiredIdempotencyInterceptor (ключ обов'язковий). Бізнес-відмови — у `payments.reverse-noncash.spec.ts`.
 */
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { INTERCEPTORS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../../prisma/prisma.service';
import { randomUUID } from 'crypto';
import { RequiredIdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';

const ORG = 'org-1';
const USER = 'emp-1';
const PAY = '44444444-4444-4444-8444-444444444444';

const serviceMock = {
  reverseNonCash: vi.fn().mockResolvedValue({ id: PAY }),
};

let jwtRole = 'ACCOUNTANT';
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user?: unknown }>();
    req.user = { id: USER, orgId: ORG, role: jwtRole };
    return true;
  }),
};

const idempotencyKeyMock = {
  create: vi.fn().mockResolvedValue({}),
  update: vi.fn().mockResolvedValue({}),
  delete: vi.fn().mockResolvedValue({}),
  findUnique: vi.fn().mockResolvedValue(null),
};

describe('POST /payments/:id/reverse — HTTP-контракт (BR-PAY-024)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        { provide: PaymentsService, useValue: serviceMock },
        // Ключ обов'язковий (RequiredIdempotencyInterceptor): резервація ключа — у пам'яті нічого не тримає.
        { provide: PrismaService, useValue: { idempotencyKey: idempotencyKeyMock } },
        RequiredIdempotencyInterceptor,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      // Справжній RolesGuard: 403 приймальні видно на рівні HTTP, а не лише в метаданих.
      .overrideGuard(RolesGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => new RolesGuard(new Reflector()).canActivate(ctx),
      })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jwtRole = 'ACCOUNTANT';
    serviceMock.reverseNonCash.mockClear();
  });

  const reverse = (payload: unknown, id = PAY, key: string | null = randomUUID()) =>
    (app as NestFastifyApplication).inject({
      method: 'POST',
      url: `/payments/${id}/reverse`,
      payload: payload as Record<string, unknown>,
      ...(key && { headers: { 'idempotency-key': key } }),
    });

  // Рішення власника 2026-10-22: без ключа повтор запиту провів би сторно двічі.
  // guards: BR-PAY-024
  it('без Idempotency-Key → 400, до сервісу не доходить', async () => {
    const res = await reverse({ reason: 'помилка' }, PAY, null);
    expect(res.statusCode).toBe(400);
    expect(serviceMock.reverseNonCash).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-024
  it.each(['OWNER', 'ADMIN', 'ACCOUNTANT'])(
    '%s → 2xx; сервіс отримує orgId, id оплати, обрізану причину й id користувача',
    async role => {
      jwtRole = role;
      const res = await reverse({ reason: '  помилкове рознесення  ' });
      expect(res.statusCode).toBeGreaterThanOrEqual(200);
      expect(res.statusCode).toBeLessThan(300);
      expect(serviceMock.reverseNonCash).toHaveBeenCalledWith(
        ORG,
        PAY,
        { reason: 'помилкове рознесення' },
        USER,
      );
    },
  );

  // guards: BR-PAY-024
  it.each(['RECEPTIONIST', 'MECHANIC'])('%s → 403, до сервісу не доходить', async role => {
    jwtRole = role;
    const res = await reverse({ reason: 'помилка' });
    expect(res.statusCode).toBe(403);
    expect(serviceMock.reverseNonCash).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-024
  it.each([
    ['без причини', {}],
    ['порожня причина', { reason: '' }],
    ['причина з самих пробілів', { reason: '   ' }],
    ['причина понад 500 символів', { reason: 'я'.repeat(501) }],
    ['причина не рядок', { reason: 42 }],
  ])('%s → 400, до сервісу не доходить', async (_n, payload) => {
    const res = await reverse(payload);
    expect(res.statusCode).toBe(400);
    expect(serviceMock.reverseNonCash).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-024
  it('причина рівно 500 символів → проходить', async () => {
    const res = await reverse({ reason: 'я'.repeat(500) });
    expect(res.statusCode).toBeLessThan(300);
    expect(serviceMock.reverseNonCash).toHaveBeenCalledTimes(1);
  });

  // guards: BR-PAY-024
  it('id оплати не UUID → 400, до сервісу не доходить', async () => {
    const res = await reverse({ reason: 'помилка' }, 'not-a-uuid');
    expect(res.statusCode).toBe(400);
    expect(serviceMock.reverseNonCash).not.toHaveBeenCalled();
  });

  // Повтор після обриву з тим самим Idempotency-Key не має дати другої спроби сторно.
  // guards: BR-PAY-024
  it('маршрут несе RequiredIdempotencyInterceptor і пускає лише OWNER, ADMIN, ACCOUNTANT', () => {
    const proto = PaymentsController.prototype as unknown as Record<string, unknown>;
    const handler = Object.getOwnPropertyNames(proto)
      .map(name => proto[name])
      .find(fn => {
        if (typeof fn !== 'function') return false;
        const path = String(Reflect.getMetadata(PATH_METADATA, fn) ?? '').replace(/^\/+/, '');
        return (
          path === ':id/reverse' && Reflect.getMetadata(METHOD_METADATA, fn) === RequestMethod.POST
        );
      }) as object | undefined;
    expect(handler, 'немає POST :id/reverse').toBeDefined();
    const interceptors = (Reflect.getMetadata(INTERCEPTORS_METADATA, handler as object) ??
      []) as unknown[];
    expect(interceptors).toContain(RequiredIdempotencyInterceptor);
    const roles = [
      ...((Reflect.getMetadata(ROLES_KEY, handler as object) as string[] | undefined) ?? []),
    ].sort();
    expect(roles).toEqual(['ACCOUNTANT', 'ADMIN', 'OWNER']);
  });

  // Рішення власника 2026-10-22: і реєстрація оплати клієнта — лише з ключем (400 без нього).
  it('POST /payments (реєстрація оплати) теж несе RequiredIdempotencyInterceptor', () => {
    const create = (PaymentsController.prototype as unknown as Record<string, unknown>).create;
    expect(Reflect.getMetadata(METHOD_METADATA, create as object)).toBe(RequestMethod.POST);
    const interceptors = (Reflect.getMetadata(INTERCEPTORS_METADATA, create as object) ??
      []) as unknown[];
    expect(interceptors).toContain(RequiredIdempotencyInterceptor);
  });
});
