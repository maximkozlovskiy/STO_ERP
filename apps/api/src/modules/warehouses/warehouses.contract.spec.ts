import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WarehousesController } from './warehouses.controller';
import { WarehousesService } from './warehouses.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

// Service mock — controller просто проксіює до сервісу
const serviceMock = {
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
};

// Mock guards — змінюємо роль через captureRole для перевірки auth gateway
let mockRole = 'ADMIN';
let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx) => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: 'emp-1', orgId: 'org-1', role: mockRole };
    return true;
  }),
};

// RolesGuard — пропускаємо завжди (logic перевіряється окремо у unit-тестах service),
// але якщо нам треба тестувати конкретну роль, можемо перемкнути на real guard.
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

const MAIN_WAREHOUSE_DTO = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: 'org-1',
  branchId: '22222222-2222-4222-8222-222222222222',
  name: 'Головний склад',
  type: 'MAIN',
  isMain: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('Warehouses — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WarehousesController],
      providers: [
        { provide: WarehousesService, useValue: serviceMock },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /warehouses', () => {
    it('200 — масив з полем isMain у кожному елементі', async () => {
      jwtAllow = true;
      serviceMock.findAll.mockResolvedValueOnce([MAIN_WAREHOUSE_DTO]);
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/warehouses',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body[0]).toMatchObject({
        id: expect.any(String),
        orgId: expect.any(String),
        branchId: expect.any(String),
        name: expect.any(String),
        isMain: expect.any(Boolean),
        type: expect.any(String),
      });
    });

    it('200 — пробросає branchId у query', async () => {
      jwtAllow = true;
      serviceMock.findAll.mockResolvedValueOnce([]);
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/warehouses?branchId=22222222-2222-4222-8222-222222222222',
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.findAll).toHaveBeenLastCalledWith('org-1', '22222222-2222-4222-8222-222222222222');
    });

    it('403/401 без авторизації', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/warehouses',
      });
      jwtAllow = true;
      // overrideGuard().useValue() з canActivate=false → 403 (Nest default)
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /warehouses', () => {
    it('201 — створює склад з isMain=true', async () => {
      jwtAllow = true;
      serviceMock.create.mockResolvedValueOnce(MAIN_WAREHOUSE_DTO);
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/warehouses',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          branchId: '22222222-2222-4222-8222-222222222222',
          name: 'Головний склад',
          type: 'MAIN',
          isMain: true,
        }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.isMain).toBe(true);
      expect(body.name).toBe('Головний склад');
    });

    it('400 — name відсутній', async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/warehouses',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          branchId: '22222222-2222-4222-8222-222222222222',
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 — branchId не UUID', async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/warehouses',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          branchId: 'not-a-uuid',
          name: 'X',
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 — isMain не boolean', async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/warehouses',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          branchId: '22222222-2222-4222-8222-222222222222',
          name: 'X',
          isMain: 'maybe',
        }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('PATCH /warehouses/:id', () => {
    it('200 — оновлення isMain', async () => {
      jwtAllow = true;
      serviceMock.update.mockResolvedValueOnce({ ...MAIN_WAREHOUSE_DTO, isMain: true });
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/warehouses/${MAIN_WAREHOUSE_DTO.id}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ isMain: true }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().isMain).toBe(true);
    });

    it('400 — type не з enum', async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/warehouses/${MAIN_WAREHOUSE_DTO.id}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'INVALID_TYPE' }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /warehouses/:id', () => {
    it('204 — soft delete', async () => {
      jwtAllow = true;
      serviceMock.remove.mockResolvedValueOnce(undefined);
      const res = await (app as NestFastifyApplication).inject({
        method: 'DELETE',
        url: `/warehouses/${MAIN_WAREHOUSE_DTO.id}`,
      });
      expect(res.statusCode).toBe(204);
    });
  });
});
