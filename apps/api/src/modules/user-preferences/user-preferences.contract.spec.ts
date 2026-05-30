import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { UserPreferencesController } from './user-preferences.controller';
import { UserPreferencesService } from './user-preferences.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const serviceMock = {
  get: vi.fn(),
  upsert: vi.fn(),
};

let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { id: 'emp-uuid-1', orgId: 'org-uuid-1', role: 'ADMIN' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

describe('UserPreferences — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [UserPreferencesController],
      providers: [{ provide: UserPreferencesService, useValue: serviceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
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
    jwtAllow = true;
    vi.clearAllMocks();
  });

  // ── GET /:key ──────────────────────────────────────────────────────────────

  it('GET /user-preferences/:key → 200 + { key, value }', async () => {
    serviceMock.get.mockResolvedValueOnce({ hiddenFields: ['phone'] });
    const res = await (app as NestFastifyApplication).inject({
      method: 'GET',
      url: '/user-preferences/detail_panel_crm',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ key: string; value: Record<string, unknown> }>();
    expect(body.key).toBe('detail_panel_crm');
    expect(body.value).toMatchObject({ hiddenFields: ['phone'] });
    expect(serviceMock.get).toHaveBeenCalledWith('org-uuid-1', 'emp-uuid-1', 'detail_panel_crm');
  });

  it('GET /user-preferences/:key → 200 + { key, value: {} } коли не знайдено', async () => {
    serviceMock.get.mockResolvedValueOnce(null);
    const res = await (app as NestFastifyApplication).inject({
      method: 'GET',
      url: '/user-preferences/detail_panel_employees',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ key: string; value: Record<string, unknown> }>();
    expect(body.key).toBe('detail_panel_employees');
    expect(body.value).toEqual({});
  });

  it('GET /user-preferences/:key → 403 без токена', async () => {
    jwtAllow = false;
    const res = await (app as NestFastifyApplication).inject({
      method: 'GET',
      url: '/user-preferences/detail_panel_crm',
    });
    expect(res.statusCode).toBe(403);
  });

  // ── PUT /:key ──────────────────────────────────────────────────────────────

  it('PUT /user-preferences/:key → 204 при валідному body', async () => {
    serviceMock.upsert.mockResolvedValueOnce(undefined);
    const res = await (app as NestFastifyApplication).inject({
      method: 'PUT',
      url: '/user-preferences/detail_panel_crm',
      payload: { key: 'detail_panel_crm', value: { hiddenFields: ['email', 'edrpou'] } },
    });
    expect(res.statusCode).toBe(204);
    expect(serviceMock.upsert).toHaveBeenCalledWith(
      'org-uuid-1',
      'emp-uuid-1',
      'detail_panel_crm',
      { hiddenFields: ['email', 'edrpou'] },
    );
  });

  it('PUT /user-preferences/:key → 400 якщо value відсутній', async () => {
    const res = await (app as NestFastifyApplication).inject({
      method: 'PUT',
      url: '/user-preferences/detail_panel_crm',
      payload: { key: 'detail_panel_crm' },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT /user-preferences/:key → 400 якщо value не об'єкт", async () => {
    const res = await (app as NestFastifyApplication).inject({
      method: 'PUT',
      url: '/user-preferences/detail_panel_crm',
      payload: { key: 'detail_panel_crm', value: 'not-an-object' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /user-preferences/:key → 403 без токена', async () => {
    jwtAllow = false;
    const res = await (app as NestFastifyApplication).inject({
      method: 'PUT',
      url: '/user-preferences/detail_panel_crm',
      payload: { key: 'detail_panel_crm', value: { hiddenFields: [] } },
    });
    expect(res.statusCode).toBe(403);
  });
});
