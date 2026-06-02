import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { GoodCategoriesController } from './good-categories.controller';
import { GoodCategoriesService } from './good-categories.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const serviceMock = {
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  toggleActive: vi.fn(),
  getLinkedWorkCategories: vi.fn(),
};

let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: 'emp-1', orgId: 'org-1', role: 'ADMIN' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const VALID_UUID_2 = '22222222-2222-4222-8222-222222222222';

describe('GoodCategories — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [GoodCategoriesController],
      providers: [{ provide: GoodCategoriesService, useValue: serviceMock }],
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

  describe('GET /good-categories', () => {
    it('повертає 200 + дерево (масив)', async () => {
      serviceMock.findAll.mockResolvedValueOnce([]);
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/good-categories',
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
      expect(serviceMock.findAll).toHaveBeenCalledWith('org-1');
    });

    it('повертає 403 коли JWT guard не пропустив', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/good-categories',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /good-categories', () => {
    it('повертає 400 коли name відсутнє', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/good-categories',
        payload: { parentId: VALID_UUID },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.create).not.toHaveBeenCalled();
    });

    it('повертає 400 при невалідному parentId UUID', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/good-categories',
        payload: { name: 'Тест', parentId: 'not-a-uuid' },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.create).not.toHaveBeenCalled();
    });

    it('повертає 201 коли parentId="" (порожній рядок → undefined через @Transform)', async () => {
      serviceMock.create.mockResolvedValueOnce({
        id: VALID_UUID,
        orgId: 'org-1',
        parentId: null,
        code: null,
        name: 'Тест',
        isSystem: false,
        isActive: true,
        sortOrder: 0,
        children: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/good-categories',
        payload: { name: 'Тест', parentId: '' },
      });
      expect(res.statusCode).toBe(201);
      const dtoArg = serviceMock.create.mock.calls[0]![1] as Record<string, unknown>;
      expect(dtoArg.parentId).toBeUndefined();
    });

    it('викликає service.create з orgId і DTO', async () => {
      serviceMock.create.mockResolvedValueOnce({
        id: VALID_UUID,
        orgId: 'org-1',
        parentId: null,
        code: null,
        name: 'Мастила',
        isSystem: false,
        isActive: true,
        sortOrder: 0,
        children: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/good-categories',
        payload: { name: 'Мастила' },
      });
      expect(res.statusCode).toBe(201);
      expect(serviceMock.create).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ name: 'Мастила' }),
      );
    });
  });

  describe('PATCH /good-categories/:id', () => {
    it('повертає 400 при невалідному UUID id', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: '/good-categories/not-a-uuid',
        payload: { name: 'Нова назва' },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.update).not.toHaveBeenCalled();
    });

    it('викликає service.update з orgId, id, DTO', async () => {
      serviceMock.update.mockResolvedValueOnce({
        id: VALID_UUID,
        orgId: 'org-1',
        parentId: null,
        code: null,
        name: 'Нова',
        isSystem: false,
        isActive: true,
        sortOrder: 0,
        children: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/good-categories/${VALID_UUID}`,
        payload: { name: 'Нова' },
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.update).toHaveBeenCalledWith(
        'org-1',
        VALID_UUID,
        expect.objectContaining({ name: 'Нова' }),
      );
    });
  });

  describe('DELETE /good-categories/:id', () => {
    it('повертає 204 при успішному soft-delete', async () => {
      serviceMock.remove.mockResolvedValueOnce(undefined);
      const res = await (app as NestFastifyApplication).inject({
        method: 'DELETE',
        url: `/good-categories/${VALID_UUID}`,
      });
      expect(res.statusCode).toBe(204);
      expect(serviceMock.remove).toHaveBeenCalledWith('org-1', VALID_UUID);
    });

    it('повертає 400 при невалідному UUID id', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'DELETE',
        url: '/good-categories/not-a-uuid',
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.remove).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /good-categories/:id/toggle-active', () => {
    it('викликає service.toggleActive з isActive=true', async () => {
      serviceMock.toggleActive.mockResolvedValueOnce({
        id: VALID_UUID,
        orgId: 'org-1',
        parentId: null,
        code: null,
        name: 'Тест',
        isSystem: false,
        isActive: true,
        sortOrder: 0,
        children: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/good-categories/${VALID_UUID}/toggle-active`,
        payload: { isActive: true },
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.toggleActive).toHaveBeenCalledWith('org-1', VALID_UUID, true);
    });

    it('повертає 400 коли isActive не boolean', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/good-categories/${VALID_UUID}/toggle-active`,
        payload: { isActive: 'yes' },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.toggleActive).not.toHaveBeenCalled();
    });

    it('повертає 400 коли isActive відсутній', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/good-categories/${VALID_UUID}/toggle-active`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.toggleActive).not.toHaveBeenCalled();
    });
  });

  describe('GET /good-categories/:id/linked-work-categories', () => {
    it('повертає 200 + масив UUID-ів', async () => {
      serviceMock.getLinkedWorkCategories.mockResolvedValueOnce([VALID_UUID_2]);
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/good-categories/${VALID_UUID}/linked-work-categories`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([VALID_UUID_2]);
      expect(serviceMock.getLinkedWorkCategories).toHaveBeenCalledWith('org-1', VALID_UUID);
    });

    // Bug #100/#155 pattern: sub-resource route must NOT be eaten by :id wildcard.
    // Якщо хтось перенесе цей роут ПІСЛЯ @Get(':id') — Fastify зробить @Get(':id')
    // match для "linked-work-categories" (як UUID-string) → ParseUUIDPipe → 400.
    it('sub-resource роут не плутається з :id (Bug #100 pattern)', async () => {
      serviceMock.getLinkedWorkCategories.mockResolvedValueOnce([]);
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/good-categories/${VALID_UUID}/linked-work-categories`,
      });
      expect(res.statusCode).toBe(200);
      // findOne (для @Get(':id')) НЕ повинен викликатись
      expect(serviceMock.findOne).not.toHaveBeenCalled();
    });
  });
});
