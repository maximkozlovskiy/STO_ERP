import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { WorkCategoriesController } from './work-categories.controller';
import { WorkCategoriesService } from './work-categories.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const serviceMock = {
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  toggleActive: vi.fn(),
  getLinkedGoodCategories: vi.fn(),
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

describe('WorkCategories — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WorkCategoriesController],
      providers: [{ provide: WorkCategoriesService, useValue: serviceMock }],
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

  describe('GET /work-categories', () => {
    it('повертає 200 + дерево (масив)', async () => {
      serviceMock.findAll.mockResolvedValueOnce([]);
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/work-categories',
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
      expect(serviceMock.findAll).toHaveBeenCalledWith('org-1');
    });

    it('повертає 403 коли JWT guard не пропустив', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/work-categories',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /work-categories', () => {
    it('повертає 400 коли name відсутнє', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/work-categories',
        payload: {},
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
        icon: null,
        sortOrder: 0,
        isSystem: false,
        isActive: true,
        children: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/work-categories',
        payload: { name: 'Тест', parentId: '' },
      });
      expect(res.statusCode).toBe(201);
      const dtoArg = serviceMock.create.mock.calls[0]![1] as Record<string, unknown>;
      expect(dtoArg.parentId).toBeUndefined();
    });
  });

  describe('PATCH /work-categories/:id/toggle-active', () => {
    it('викликає service.toggleActive з isActive=false', async () => {
      serviceMock.toggleActive.mockResolvedValueOnce({
        id: VALID_UUID,
        orgId: 'org-1',
        parentId: null,
        code: null,
        name: 'Тест',
        icon: null,
        sortOrder: 0,
        isSystem: false,
        isActive: false,
        children: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/work-categories/${VALID_UUID}/toggle-active`,
        payload: { isActive: false },
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.toggleActive).toHaveBeenCalledWith('org-1', VALID_UUID, false);
    });

    it('повертає 400 коли isActive не boolean', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/work-categories/${VALID_UUID}/toggle-active`,
        payload: { isActive: 'нi' },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.toggleActive).not.toHaveBeenCalled();
    });

    it('повертає 400 при невалідному UUID id', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: '/work-categories/not-a-uuid/toggle-active',
        payload: { isActive: true },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.toggleActive).not.toHaveBeenCalled();
    });
  });

  describe('GET /work-categories/:id/linked-good-categories', () => {
    it('повертає 200 + масив UUID-ів', async () => {
      serviceMock.getLinkedGoodCategories.mockResolvedValueOnce([VALID_UUID_2]);
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/work-categories/${VALID_UUID}/linked-good-categories`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([VALID_UUID_2]);
      expect(serviceMock.getLinkedGoodCategories).toHaveBeenCalledWith('org-1', VALID_UUID);
    });

    // Bug #100 pattern: sub-resource ПЕРЕД :id (інакше Fastify матчить :id).
    it('sub-resource роут не плутається з :id', async () => {
      serviceMock.getLinkedGoodCategories.mockResolvedValueOnce([]);
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/work-categories/${VALID_UUID}/linked-good-categories`,
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.findOne).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /work-categories/:id', () => {
    it('повертає 204 при успіху', async () => {
      serviceMock.remove.mockResolvedValueOnce(undefined);
      const res = await (app as NestFastifyApplication).inject({
        method: 'DELETE',
        url: `/work-categories/${VALID_UUID}`,
      });
      expect(res.statusCode).toBe(204);
      expect(serviceMock.remove).toHaveBeenCalledWith('org-1', VALID_UUID);
    });
  });
});
