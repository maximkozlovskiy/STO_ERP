import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UnitsController } from './units.controller';
import { UnitsService } from './units.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

// Contract test для soft-delete + restore + coefficient валідації одиниць виміру (Bugs #295-#305).

const serviceMock = {
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  restore: vi.fn(),
};

const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: 'emp-1', orgId: 'org-1', role: 'ADMIN' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

const UNIT_DTO = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: 'org-1',
  name: 'штука',
  shortName: 'шт',
  isSystem: false,
  coefficient: 1,
  width: null,
  height: null,
  depth: null,
  volume: null,
  weight: null,
  deletedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('Units — HTTP Contract (Bugs #295-#305 regression guard)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [UnitsController],
      providers: [{ provide: UnitsService, useValue: serviceMock }],
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

  describe('POST /units — coefficient валідація (Bug #302)', () => {
    it('201 — приймає coefficient=1', async () => {
      serviceMock.create.mockResolvedValueOnce(UNIT_DTO);
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/units',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'штука', shortName: 'шт', coefficient: 1 }),
      });
      expect(res.statusCode).toBe(201);
    });

    it('400 — відхиляє coefficient=0 (divide-by-zero у qty_base = qty / coefficient)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/units',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'штука', shortName: 'шт', coefficient: 0 }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("400 — відхиляє від'ємний coefficient=-1", async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/units',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'штука', shortName: 'шт', coefficient: -1 }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('201 — coefficient відсутній (optional)', async () => {
      serviceMock.create.mockResolvedValueOnce(UNIT_DTO);
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/units',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'штука', shortName: 'шт' }),
      });
      expect(res.statusCode).toBe(201);
    });

    it('400 — відхиляє isSystem у whitelist (forbidNonWhitelisted)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/units',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'штука', shortName: 'шт', isSystem: true }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('PATCH /units/:id — coefficient валідація (Bug #302)', () => {
    it('400 — відхиляє coefficient=0', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/units/${UNIT_DTO.id}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ coefficient: 0 }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('200 — приймає coefficient=2.5', async () => {
      serviceMock.update.mockResolvedValueOnce({ ...UNIT_DTO, coefficient: 2.5 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/units/${UNIT_DTO.id}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ coefficient: 2.5 }),
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /units — showDeleted фільтр', () => {
    it('200 — без showDeleted: сервіс викликається з false', async () => {
      serviceMock.findAll.mockResolvedValueOnce([UNIT_DTO]);
      const res = await (app as NestFastifyApplication).inject({ method: 'GET', url: '/units' });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.findAll).toHaveBeenLastCalledWith('org-1', false);
    });

    it('200 — showDeleted=true: сервіс викликається з true', async () => {
      serviceMock.findAll.mockResolvedValueOnce([UNIT_DTO]);
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/units?showDeleted=true',
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.findAll).toHaveBeenLastCalledWith('org-1', true);
    });

    it('200 — showDeleted=false (рядок): сервіс викликається з false', async () => {
      serviceMock.findAll.mockResolvedValueOnce([UNIT_DTO]);
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/units?showDeleted=false',
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.findAll).toHaveBeenLastCalledWith('org-1', false);
    });

    it('200 — Cache-Control: no-cache (Bug #299)', async () => {
      serviceMock.findAll.mockResolvedValueOnce([UNIT_DTO]);
      const res = await (app as NestFastifyApplication).inject({ method: 'GET', url: '/units' });
      const cacheCtl = res.headers['cache-control'];
      expect(cacheCtl).toBeDefined();
      expect(String(cacheCtl)).toContain('no-cache');
      expect(String(cacheCtl)).not.toContain('max-age=300');
    });
  });

  describe('POST /units/:id/restore', () => {
    it('200 — викликає restore сервісу', async () => {
      serviceMock.restore.mockResolvedValueOnce({ ...UNIT_DTO, deletedAt: null });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: `/units/${UNIT_DTO.id}/restore`,
      });
      expect(res.statusCode).toBe(201);
      expect(serviceMock.restore).toHaveBeenLastCalledWith('org-1', UNIT_DTO.id);
    });

    it('400 — invalid UUID у параметрі', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/units/not-a-uuid/restore',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /units/:id', () => {
    it('204 — soft delete', async () => {
      serviceMock.remove.mockResolvedValueOnce(undefined);
      const res = await (app as NestFastifyApplication).inject({
        method: 'DELETE',
        url: `/units/${UNIT_DTO.id}`,
      });
      expect(res.statusCode).toBe(204);
    });
  });
});
