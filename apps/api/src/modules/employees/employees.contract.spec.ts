import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

/**
 * Bug #175: HTTP-contract покриття для employees assignment-endpoints.
 *
 * saveEditEmp (apps/web/src/app/employees/page.tsx) викликає 4 endpoint-и ПАРАЛЕЛЬНО
 * через Promise.all: POST /:id/zones, /lifts, /work-categories, /branches.
 * Цей spec фіксує контракт усіх 4: 200 при валідному body, 400 при невалідному UUID,
 * 403 без авторизації, та правильний UUID-формат у :id (ParseUUIDPipe).
 */
const serviceMock = {
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  assignZones: vi.fn(),
  assignLifts: vi.fn(),
  assignWorkCategories: vi.fn(),
  assignBranches: vi.fn(),
};

let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx) => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { id: 'emp-1', orgId: 'org-1', role: 'ADMIN' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

// Валідний UUID v4 layout (@IsUUID('4') відхиляє nil-UUID — SKILL §1.2)
const EMP_ID = '11111111-1111-4111-8111-111111111111';
const FK_A = '22222222-2222-4222-8222-222222222222';
const FK_B = '33333333-3333-4333-8333-333333333333';

describe('Employees — HTTP Contract (assignment endpoints)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [EmployeesController],
      providers: [{ provide: EmployeesService, useValue: serviceMock }],
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

  beforeEach(() => {
    jwtAllow = true;
    vi.clearAllMocks();
  });

  const okEmployee = {
    id: EMP_ID, orgId: 'org-1', firstName: 'Іван', lastName: 'Коваль',
    role: 'MECHANIC', status: 'ACTIVE', zoneIds: [], liftIds: [],
    workCategoryIds: [], branchIds: [], allBranches: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };

  // Кожен з 4 endpoint-ів: { url-suffix, body-key, service-method }
  const cases = [
    { suffix: 'zones', key: 'zoneIds', method: 'assignZones' as const },
    { suffix: 'lifts', key: 'liftIds', method: 'assignLifts' as const },
    { suffix: 'work-categories', key: 'workCategoryIds', method: 'assignWorkCategories' as const },
  ];

  describe.each(cases)('POST /employees/:id/$suffix', ({ suffix, key, method }) => {
    it(`повертає 200/201 при валідному body { ${key}: [uuid] }`, async () => {
      serviceMock[method].mockResolvedValueOnce(okEmployee);
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: `/employees/${EMP_ID}/${suffix}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ [key]: [FK_A, FK_B] }),
      });
      expect([200, 201]).toContain(res.statusCode);
      expect(serviceMock[method]).toHaveBeenCalledWith(
        'org-1', EMP_ID, expect.objectContaining({ [key]: [FK_A, FK_B] }),
      );
    });

    it(`приймає порожній масив { ${key}: [] } (зняти всі призначення)`, async () => {
      serviceMock[method].mockResolvedValueOnce(okEmployee);
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: `/employees/${EMP_ID}/${suffix}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ [key]: [] }),
      });
      expect([200, 201]).toContain(res.statusCode);
    });

    it(`відхиляє невалідний UUID у ${key} з 400`, async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: `/employees/${EMP_ID}/${suffix}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ [key]: ['not-a-uuid'] }),
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock[method]).not.toHaveBeenCalled();
    });

    it('відхиляє невалідний :id (не-UUID) з 400 (ParseUUIDPipe)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: `/employees/not-a-uuid/${suffix}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ [key]: [FK_A] }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 403 без авторизації', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: `/employees/${EMP_ID}/${suffix}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ [key]: [FK_A] }),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /employees/:id/branches', () => {
    it('повертає 200/201 при { branchIds: [uuid], allBranches: false }', async () => {
      serviceMock.assignBranches.mockResolvedValueOnce(okEmployee);
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: `/employees/${EMP_ID}/branches`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ branchIds: [FK_A], allBranches: false }),
      });
      expect([200, 201]).toContain(res.statusCode);
      expect(serviceMock.assignBranches).toHaveBeenCalledWith(
        'org-1', EMP_ID, expect.objectContaining({ branchIds: [FK_A], allBranches: false }),
      );
    });

    it('приймає { branchIds: [], allBranches: true } (доступ до всіх філій)', async () => {
      serviceMock.assignBranches.mockResolvedValueOnce({ ...okEmployee, allBranches: true });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: `/employees/${EMP_ID}/branches`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ branchIds: [], allBranches: true }),
      });
      expect([200, 201]).toContain(res.statusCode);
    });

    it('відхиляє невалідний UUID у branchIds з 400', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: `/employees/${EMP_ID}/branches`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ branchIds: ['bad'] }),
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.assignBranches).not.toHaveBeenCalled();
    });

    it('повертає 403 без авторизації', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: `/employees/${EMP_ID}/branches`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ branchIds: [FK_A] }),
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
