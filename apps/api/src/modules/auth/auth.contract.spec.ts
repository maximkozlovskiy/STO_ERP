import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AuthController } from '../../auth/auth.controller';
import { AuthService } from '../../auth/auth.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';

const serviceMock = {
  login: vi.fn(),
  refresh: vi.fn(),
  logout: vi.fn(),
};

let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx) => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: 'emp-1', orgId: 'org-1', role: 'ADMIN' };
    return true;
  }),
};

describe('Auth — HTTP Contract', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: serviceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie);
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /auth/login', () => {
    it('повертає 200 з accessToken + employee shape', async () => {
      serviceMock.login.mockResolvedValueOnce({
        accessToken: 'eyJhbGc.mock.token',
        employee: {
          id: 'emp-1',
          orgId: 'org-1',
          firstName: 'Іван',
          lastName: 'Петренко',
          role: 'ADMIN',
        },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'admin@sto.local', password: 'secret123' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Contract з фронтендом: accessToken (string) + employee object
      expect(body).toMatchObject({
        accessToken: expect.any(String),
        employee: expect.objectContaining({
          id: expect.any(String),
          orgId: expect.any(String),
          firstName: expect.any(String),
          lastName: expect.any(String),
          role: expect.any(String),
        }),
      });
    });

    it('повертає 400 при невалідному форматі email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'not-an-email', password: 'secret' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 при пустому body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 при занадто короткому паролі', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'admin@sto.local', password: 'ab' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('коли сервіс кидає UnauthorizedException → 401', async () => {
      const { UnauthorizedException } = await import('@nestjs/common');
      serviceMock.login.mockRejectedValueOnce(
        new UnauthorizedException('Невірний email або пароль'),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'admin@sto.local', password: 'wrongpass' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /auth/refresh', () => {
    it('повертає 200 з оновленим accessToken', async () => {
      serviceMock.refresh.mockResolvedValueOnce({
        accessToken: 'new.access.token',
        employee: {
          id: 'emp-1',
          orgId: 'org-1',
          firstName: 'Іван',
          lastName: 'Петренко',
          role: 'ADMIN',
        },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: { sto_refresh: 'valid.refresh.token' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        accessToken: expect.any(String),
        employee: expect.any(Object),
      });
    });

    it('повертає 401 коли refresh token відсутній або невалідний', async () => {
      const { UnauthorizedException } = await import('@nestjs/common');
      serviceMock.refresh.mockRejectedValueOnce(
        new UnauthorizedException('Сесія застаріла, увійдіть знову'),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('повертає 204 з валідним JWT', async () => {
      jwtAllow = true;
      serviceMock.logout.mockReturnValueOnce(undefined);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
      });
      expect(res.statusCode).toBe(204);
    });

    it('повертає 403 коли guard не пропустив', async () => {
      jwtAllow = false;
      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
      });
      jwtAllow = true;
      expect(res.statusCode).toBe(403);
    });
  });
});
