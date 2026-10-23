import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { VehicleMakesController, VehicleModelsController } from './vehicle-makes.controller';
import { VehicleMakesService } from './vehicle-makes.service';
import { VehicleModelsService } from './vehicle-models.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';

/**
 * HTTP-контракт довідника марок і моделей: ролі кожного маршруту (BR-VEH-013), UUID у шляху,
 * zod-валідація тіла. RolesGuard СПРАВЖНІЙ — читає `@Roles(...)` обробника; підмінено лише
 * JwtAuthGuard (кладе користувача з роллю тесту). Сервіси — моки: що вони роблять, стережуть
 * `vehicle-makes.names.spec.ts` і `vehicle-makes.delete-merge.spec.ts`.
 */
const ID = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

const makes = {
  findAll: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  restore: vi.fn(),
  merge: vi.fn(),
};
const models = {
  findAll: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  restore: vi.fn(),
  merge: vi.fn(),
};

let role = 'ADMIN';
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user?: unknown }>();
    req.user = { id: 'emp-1', orgId: 'org-1', role };
    return true;
  }),
};

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
interface Route {
  method: Method;
  url: string;
  body?: Record<string, unknown>;
  fn: ReturnType<typeof vi.fn>;
}

const READ: Route[] = [
  { method: 'GET', url: '/vehicle-makes', fn: makes.findAll },
  { method: 'GET', url: `/vehicle-makes/${ID}/models`, fn: models.findAll },
];
const WRITE: Route[] = [
  { method: 'POST', url: '/vehicle-makes', body: { name: 'Toyota' }, fn: makes.create },
  { method: 'PATCH', url: `/vehicle-makes/${ID}`, body: { name: 'Toyota' }, fn: makes.rename },
  {
    method: 'POST',
    url: `/vehicle-makes/${ID}/models`,
    body: { name: 'Camry' },
    fn: models.create,
  },
  { method: 'PATCH', url: `/vehicle-models/${ID}`, body: { name: 'Camry' }, fn: models.rename },
];
const MANAGE: Route[] = [
  { method: 'DELETE', url: `/vehicle-makes/${ID}`, fn: makes.remove },
  { method: 'POST', url: `/vehicle-makes/${ID}/restore`, fn: makes.restore },
  {
    method: 'POST',
    url: `/vehicle-makes/${ID}/merge`,
    body: { targetId: TARGET },
    fn: makes.merge,
  },
  { method: 'DELETE', url: `/vehicle-models/${ID}`, fn: models.remove },
  { method: 'POST', url: `/vehicle-models/${ID}/restore`, fn: models.restore },
  {
    method: 'POST',
    url: `/vehicle-models/${ID}/merge`,
    body: { targetId: TARGET },
    fn: models.merge,
  },
];

const label = (r: Route) => `${r.method} ${r.url.replace(ID, ':id')}`;
const ALL_ROLES = ['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT', 'MECHANIC', 'STOREKEEPER'];

describe('Vehicle makes / models — HTTP Contract', () => {
  let app: INestApplication;

  const call = (r: Route) =>
    (app as NestFastifyApplication).inject({
      method: r.method,
      url: r.url,
      ...(r.body ? { payload: r.body } : {}),
    });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [VehicleMakesController, VehicleModelsController],
      providers: [
        { provide: VehicleMakesService, useValue: makes },
        { provide: VehicleModelsService, useValue: models },
        { provide: PrismaService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
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
    role = 'ADMIN';
    for (const fn of [...Object.values(makes), ...Object.values(models)]) {
      fn.mockReset();
      fn.mockResolvedValue({});
    }
  });

  // guards: BR-VEH-013
  describe.each([
    ['читання', READ, ['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT', 'MECHANIC']],
    ['створення й перейменування', WRITE, ['OWNER', 'ADMIN', 'RECEPTIONIST']],
    ['видалення, відновлення, злиття', MANAGE, ['OWNER', 'ADMIN']],
  ] as const)('%s', (_group, routes, allowed) => {
    for (const route of routes) {
      for (const r of ALL_ROLES) {
        const ok = (allowed as readonly string[]).includes(r);
        it(`${label(route)} — ${r} → ${ok ? 'дозволено' : '403'}`, async () => {
          role = r;
          const res = await call(route);
          if (ok) {
            expect(res.statusCode).toBeLessThan(300);
            expect(route.fn).toHaveBeenCalledTimes(1);
          } else {
            expect(res.statusCode).toBe(403);
            expect(route.fn).not.toHaveBeenCalled();
          }
        });
      }
    }
  });

  it('сервіс отримує orgId із токена, id зі шляху й нормалізовану назву', async () => {
    await call({ ...WRITE[1], body: { name: '  Land   Rover ' } });
    expect(makes.rename).toHaveBeenCalledWith('org-1', ID, { name: 'Land Rover' });
  });

  it('злиття: ціль — з тіла', async () => {
    await call(MANAGE[2]);
    expect(makes.merge).toHaveBeenCalledWith('org-1', ID, TARGET);
  });

  it.each([
    ['порожня назва', { name: '   ' }],
    ['назва довша за 100 символів', { name: 'x'.repeat(101) }],
  ])('%s → 400, сервіс не викликається', async (_l, body) => {
    const res = await call({ ...WRITE[0], body });
    expect(res.statusCode).toBe(400);
    expect(makes.create).not.toHaveBeenCalled();
  });

  it('злиття без UUID цілі → 400', async () => {
    const res = await call({ ...MANAGE[2], body: { targetId: 'nope' } });
    expect(res.statusCode).toBe(400);
    expect(makes.merge).not.toHaveBeenCalled();
  });

  it.each([...READ.slice(1), ...WRITE.slice(1), ...MANAGE])(
    '$method $url з id не-UUID → 400',
    async route => {
      const res = await call({ ...route, url: route.url.replace(ID, 'not-a-uuid') });
      expect(res.statusCode).toBe(400);
      expect(route.fn).not.toHaveBeenCalled();
    },
  );

  it('DELETE → 204; restore і merge → 200 (не 201)', async () => {
    expect((await call(MANAGE[0])).statusCode).toBe(204);
    expect((await call(MANAGE[1])).statusCode).toBe(200);
    expect((await call(MANAGE[2])).statusCode).toBe(200);
  });
});
