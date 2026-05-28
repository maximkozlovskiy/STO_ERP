import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { CashRegistersController } from './cash-registers.controller';
import { CashRegistersService } from './cash-registers.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const serviceMock = {
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
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
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

// v4-layout UUIDs (13-й hex = '4', 17-й ∈ 8-b) — @IsUUID() (version 'all') приймає.
const CURRENCY_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';

describe('CashRegisters — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CashRegistersController],
      providers: [{ provide: CashRegistersService, useValue: serviceMock }],
    })
      .overrideGuard(JwtAuthGuard).useValue(mockJwtGuard)
      .overrideGuard(RolesGuard).useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Mirror production pipe (main.ts) so @IsUUID/@IsNotEmpty → 400.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
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

  describe('GET /cash-registers', () => {
    it('повертає 200 + { items, total } (не голий масив)', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0 });
      const res = await (app as NestFastifyApplication).inject({ method: 'GET', url: '/cash-registers' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ items: expect.any(Array), total: expect.any(Number) });
    });

    it('прокидає branchId-фільтр у сервіс', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0 });
      await (app as NestFastifyApplication).inject({ method: 'GET', url: `/cash-registers?branchId=${BRANCH_ID}` });
      expect(serviceMock.findAll).toHaveBeenCalledWith('org-1', BRANCH_ID);
    });

    it('повертає 403 коли guard не пропустив', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({ method: 'GET', url: '/cash-registers' });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /cash-registers — валідація обовʼязкових полів', () => {
    it('повертає 400 коли currencyId/branchId відсутні', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/cash-registers',
        payload: { name: 'Каса №1' },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.create).not.toHaveBeenCalled();
    });

    it('повертає 400 коли currencyId не UUID', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/cash-registers',
        payload: { name: 'Каса №1', currencyId: 'not-a-uuid', branchId: BRANCH_ID },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.create).not.toHaveBeenCalled();
    });

    it('повертає 201 + DTO shape при валідному payload', async () => {
      serviceMock.create.mockResolvedValueOnce({
        id: 'cr-1', orgId: 'org-1', name: 'Каса №1',
        currencyId: CURRENCY_ID, currencyCode: 'UAH', currencySymbol: '₴',
        branchId: BRANCH_ID, branchName: 'Головний офіс',
        createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/cash-registers',
        payload: { name: 'Каса №1', currencyId: CURRENCY_ID, branchId: BRANCH_ID },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ id: expect.any(String), name: 'Каса №1', currencyCode: 'UAH', branchName: 'Головний офіс' });
      expect(serviceMock.create).toHaveBeenCalledWith('org-1', expect.objectContaining({ currencyId: CURRENCY_ID, branchId: BRANCH_ID }));
    });
  });
});
