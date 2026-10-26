import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';

/**
 * HTTP-контракт `/tasks`: розбір параметрів — тією самою `ValidationPipe`, що в main.ts; тіло
 * форми — `taskFormSchema`; ролі — справжнім `RolesGuard` (підмінено лише JWT, що кладе
 * користувача з потрібною роллю); `:id/transition` не перекритий `:id`.
 */

const serviceMock = {
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  transition: vi.fn(),
};

let role = 'ADMIN';
const jwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    ctx.switchToHttp().getRequest().user = { id: 'emp-1', orgId: 'org-1', role };
    return true;
  }),
};

const ID = '55555555-5555-4555-8555-000000000001';
const ASSIGNEE = '11111111-1111-4111-8111-00000000000a';
const EMPTY = { items: [], total: 0, page: 1, limit: 20 };
const FORM = { title: 'Замінити лампу', assigneeId: ASSIGNEE };

describe('Tasks — HTTP контракт', () => {
  let app: NestFastifyApplication;
  const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, payload });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TasksController],
      providers: [{ provide: TasksService, useValue: serviceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(jwtGuard)
      .compile();
    const nest: INestApplication = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    nest.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await nest.init();
    app = nest as NestFastifyApplication;
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    role = 'ADMIN';
    for (const fn of Object.values(serviceMock)) fn.mockReset().mockResolvedValue({});
    serviceMock.findAll.mockResolvedValue(EMPTY);
  });

  describe('GET /tasks', () => {
    // guards: BR-TASK-002
    it('200; організація й користувач — з токена, page/limit — числа', async () => {
      const res = await inject('GET', '/tasks?page=2&limit=50');

      expect(res.statusCode).toBe(200);
      expect(serviceMock.findAll).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ id: 'emp-1', role: 'ADMIN' }),
        expect.objectContaining({ page: 2, limit: 50 }),
      );
    });

    // guards: BR-TASK-002
    it.each([
      ['через кому', '/tasks?status=NEW,IN_PROGRESS', ['NEW', 'IN_PROGRESS']],
      ['повторений параметр', '/tasks?status=DONE&status=CANCELLED', ['DONE', 'CANCELLED']],
    ])('?status= %s → масив статусів', async (_how, url, expected) => {
      const res = await inject('GET', url);

      expect(res.statusCode).toBe(200);
      expect(serviceMock.findAll.mock.calls[0][2].status).toEqual(expected);
    });

    // guards: BR-TASK-002
    it('мобільний запит «мої відкриті» (?mine=1&status=NEW,IN_PROGRESS,DONE) приймається', async () => {
      const res = await inject('GET', '/tasks?mine=1&status=NEW,IN_PROGRESS,DONE');

      expect(res.statusCode).toBe(200);
      expect(serviceMock.findAll.mock.calls[0][2]).toMatchObject({ mine: '1' });
    });

    // guards: BR-TASK-002
    it('мобільний запит «останні виконані» (?status=DONE&sortBy=completedAt&sortDir=desc) приймається', async () => {
      const res = await inject('GET', '/tasks?mine=1&status=DONE&sortBy=completedAt&sortDir=desc');

      expect(res.statusCode).toBe(200);
      expect(serviceMock.findAll.mock.calls[0][2]).toMatchObject({
        status: ['DONE'],
        sortBy: 'completedAt',
        sortDir: 'desc',
      });
    });

    // guards: BR-TASK-004
    it.each([
      ['неіснуюча дата', '/tasks?from=2026-02-31'],
      ['рік 0000', '/tasks?from=0000-01-01'],
      ['мітка часу замість дня', '/tasks?to=2026-05-22T10:00:00Z'],
      ['сміття', '/tasks?to=abc'],
      ['невідомий статус', '/tasks?status=OPEN'],
      ['невідомий пріоритет', '/tasks?priority=TOP'],
      ['mine не булеве', '/tasks?mine=yes'],
      ['limit понад 200', '/tasks?limit=201'],
      ['sortBy поза переліком', '/tasks?sortBy=title'],
      ['assigneeId не UUID', '/tasks?assigneeId=abc'],
      ['q довший за 100', `/tasks?q=${'а'.repeat(101)}`],
    ])('%s → 400, сервіс не викликано', async (_why, url) => {
      const res = await inject('GET', encodeURI(url));

      expect(res.statusCode).toBe(400);
      expect(serviceMock.findAll).not.toHaveBeenCalled();
    });

    // guards: BR-TASK-002
    it.each(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER', 'ACCOUNTANT'])(
      'роль %s читає список (видимість вирішує сервіс)',
      async r => {
        role = r;
        expect((await inject('GET', '/tasks')).statusCode).toBe(200);
      },
    );

    it('роль CLIENT → 403', async () => {
      role = 'CLIENT';
      expect((await inject('GET', '/tasks')).statusCode).toBe(403);
    });
  });

  describe('Запис (BR-TASK-001)', () => {
    // guards: BR-TASK-001
    it.each(['OWNER', 'ADMIN', 'RECEPTIONIST'])('%s ставить задачу → 201', async r => {
      role = r;
      const res = await inject('POST', '/tasks', FORM);

      expect(res.statusCode).toBe(201);
      expect(serviceMock.create).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ id: 'emp-1', role: r }),
        expect.objectContaining({ title: 'Замінити лампу', priority: 'NORMAL' }),
      );
    });

    // guards: BR-TASK-001
    it.each(['MECHANIC', 'STOREKEEPER', 'ACCOUNTANT'])(
      '%s не ставить, не править і не видаляє → 403, сервіс не викликано',
      async r => {
        role = r;
        const codes = [
          (await inject('POST', '/tasks', FORM)).statusCode,
          (await inject('PATCH', `/tasks/${ID}`, FORM)).statusCode,
          (await inject('DELETE', `/tasks/${ID}`)).statusCode,
        ];

        expect(codes).toEqual([403, 403, 403]);
        expect(serviceMock.create).not.toHaveBeenCalled();
        expect(serviceMock.update).not.toHaveBeenCalled();
        expect(serviceMock.remove).not.toHaveBeenCalled();
      },
    );

    // guards: BR-TASK-001
    it.each([
      ['порожня назва', { ...FORM, title: '   ' }],
      ['назва довша за 200', { ...FORM, title: 'я'.repeat(201) }],
      ['без виконавця', { title: 'x' }],
      ['виконавець не UUID', { ...FORM, assigneeId: 'abc' }],
      ['невідомий пріоритет', { ...FORM, priority: 'TOP' }],
      ['дата — сміття', { ...FORM, dueAt: 'завтра' }],
      [
        'термін раніше початку',
        { ...FORM, startAt: '2026-05-22T10:00:00Z', dueAt: '2026-05-22T09:00:00Z' },
      ],
    ])('POST: %s → 400 українською, сервіс не викликано', async (_why, body) => {
      const res = await inject('POST', '/tasks', body);

      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toMatch(/[а-яіїєґ]/i);
      expect(serviceMock.create).not.toHaveBeenCalled();
    });

    it('DELETE → 204', async () => {
      const res = await inject('DELETE', `/tasks/${ID}`);

      expect(res.statusCode).toBe(204);
      expect(serviceMock.remove).toHaveBeenCalledWith('org-1', ID);
    });

    it('id не UUID → 400', async () => {
      expect((await inject('GET', '/tasks/abc')).statusCode).toBe(400);
    });
  });

  describe('POST /tasks/:id/transition (BR-TASK-003)', () => {
    // guards: BR-TASK-003
    it('механік рухає статус → 200; маршрут не перекритий `:id`', async () => {
      role = 'MECHANIC';
      const res = await inject('POST', `/tasks/${ID}/transition`, { status: 'IN_PROGRESS' });

      expect(res.statusCode).toBe(200);
      expect(serviceMock.transition).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ id: 'emp-1', role: 'MECHANIC' }),
        ID,
        'IN_PROGRESS',
      );
    });

    // guards: BR-TASK-003
    it.each([{ status: 'CLOSED' }, {}, { status: 'DONE', extra: 1 }])(
      'тіло %j → 400',
      async body => {
        const res = await inject('POST', `/tasks/${ID}/transition`, body);

        expect(res.statusCode).toBe(400);
        expect(serviceMock.transition).not.toHaveBeenCalled();
      },
    );
  });
});
