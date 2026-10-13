import type { INestApplication } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

/**
 * Звільнення працівника (BR-EMP-001): перехід статусу в FIRED відкликає всі видані токени,
 * а поставити «звільнено» самому собі не можна.
 *
 * Вхід і чинну сесію звільненого закривають AuthService і JwtStrategy (auth.spec.ts,
 * jwt.strategy.spec.ts). Тут — те, що робить сам PATCH /employees/:id.
 */

const ORG = 'org-1';
const EMP_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '99999999-9999-4999-8999-999999999999';

const row = (over: Record<string, unknown> = {}) => ({
  id: EMP_ID,
  orgId: ORG,
  userId: null,
  firstName: 'Іван',
  lastName: 'Коваль',
  role: 'MECHANIC',
  status: 'ACTIVE',
  rateScheme: null,
  allBranches: false,
  createdAt: new Date('2026-10-01T08:00:00Z'),
  updatedAt: new Date('2026-10-13T08:00:00Z'),
  deletedAt: null,
  employeeZones: [],
  employeeLifts: [],
  employeeWorkCategories: [],
  employeeBranches: [],
  ...over,
});

// guards: BR-EMP-001
describe('EmployeesService.update — звільнення (перехід у FIRED)', () => {
  let service: EmployeesService;
  /** Журнал записів усередині транзакції: що і в якому порядку записано. */
  let txLog: string[];
  let tx: {
    employee: { update: ReturnType<typeof vi.fn> };
    authAccount: { updateMany: ReturnType<typeof vi.fn> };
  };
  let prisma: {
    employee: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    authAccount: { updateMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    txLog = [];
    tx = {
      employee: {
        update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          txLog.push('employee.update');
          return Promise.resolve(row(data));
        }),
      },
      authAccount: {
        updateMany: vi.fn().mockImplementation(() => {
          txLog.push('authAccount.updateMany');
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    prisma = {
      employee: { findFirst: vi.fn(), update: vi.fn() },
      // Записи ПОЗА транзакцією — окремі заглушки: якщо сервіс напише повз tx, тест це побачить.
      authAccount: { updateMany: vi.fn() },
      $transaction: vi
        .fn()
        .mockImplementation(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
    };

    const module = await Test.createTestingModule({
      providers: [EmployeesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(EmployeesService);
  });

  it('ACTIVE → FIRED: tokenVersion +1 у ТІЙ САМІЙ транзакції, що й зміна статусу', async () => {
    prisma.employee.findFirst.mockResolvedValue({ id: EMP_ID, status: 'ACTIVE' });

    const res = await service.update(ORG, EMP_ID, { status: 'FIRED' }, ADMIN_ID);

    expect(res.status).toBe('FIRED');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(txLog).toEqual(['employee.update', 'authAccount.updateMany']);
    expect(tx.authAccount.updateMany).toHaveBeenCalledWith({
      where: { employeeId: EMP_ID, orgId: ORG, deletedAt: null },
      data: { tokenVersion: { increment: 1 } },
    });
    // Нічого не записано повз транзакцію.
    expect(prisma.authAccount.updateMany).not.toHaveBeenCalled();
    expect(prisma.employee.update).not.toHaveBeenCalled();
  });

  it('ON_LEAVE → FIRED теж відкликає токени', async () => {
    prisma.employee.findFirst.mockResolvedValue({ id: EMP_ID, status: 'ON_LEAVE' });

    await service.update(ORG, EMP_ID, { status: 'FIRED' }, ADMIN_ID);

    expect(tx.authAccount.updateMany).toHaveBeenCalledTimes(1);
  });

  it('збій запису версії відкочує і зміну статусу: помилка виходить із транзакції', async () => {
    prisma.employee.findFirst.mockResolvedValue({ id: EMP_ID, status: 'ACTIVE' });
    tx.authAccount.updateMany.mockRejectedValueOnce(new Error('db down'));

    // Помилка кинута зсередини колбека $transaction → Prisma відкочує employee.update.
    await expect(service.update(ORG, EMP_ID, { status: 'FIRED' }, ADMIN_ID)).rejects.toThrow(
      'db down',
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('повторний PATCH уже звільненого (FIRED → FIRED) версію не чіпає', async () => {
    prisma.employee.findFirst.mockResolvedValue({ id: EMP_ID, status: 'FIRED' });

    await service.update(ORG, EMP_ID, { status: 'FIRED', phone: '+380501112233' }, ADMIN_ID);

    expect(tx.employee.update).toHaveBeenCalledTimes(1);
    expect(tx.authAccount.updateMany).not.toHaveBeenCalled();
  });

  it('повернення FIRED → ACTIVE версію не чіпає: старі токени лишаються мертвими', async () => {
    prisma.employee.findFirst.mockResolvedValue({ id: EMP_ID, status: 'FIRED' });

    const res = await service.update(ORG, EMP_ID, { status: 'ACTIVE' }, ADMIN_ID);

    expect(res.status).toBe('ACTIVE');
    expect(tx.authAccount.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['інші поля без status', { firstName: 'Петро', phone: '+380501112233' }],
    ['status = ON_LEAVE', { status: 'ON_LEAVE' as const }],
    ['status = ACTIVE', { status: 'ACTIVE' as const }],
  ])('%s — версію не чіпає', async (_name, dto) => {
    prisma.employee.findFirst.mockResolvedValue({ id: EMP_ID, status: 'ACTIVE' });

    await service.update(ORG, EMP_ID, dto, ADMIN_ID);

    expect(tx.employee.update).toHaveBeenCalledTimes(1);
    expect(tx.authAccount.updateMany).not.toHaveBeenCalled();
  });

  it('самому собі FIRED → 400 з поясненням, і нічого не записано', async () => {
    prisma.employee.findFirst.mockResolvedValue({ id: ADMIN_ID, status: 'ACTIVE' });

    await expect(service.update(ORG, ADMIN_ID, { status: 'FIRED' }, ADMIN_ID)).rejects.toThrow(
      new BadRequestException('Не можна звільнити самого себе: це закрило б вам вхід у систему'),
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.employee.update).not.toHaveBeenCalled();
    expect(tx.authAccount.updateMany).not.toHaveBeenCalled();
  });

  it('собі можна міняти інші поля й статус ON_LEAVE — запобіжник лише про FIRED', async () => {
    prisma.employee.findFirst.mockResolvedValue({ id: ADMIN_ID, status: 'ACTIVE' });

    await expect(
      service.update(ORG, ADMIN_ID, { status: 'ON_LEAVE', phone: '+380501112233' }, ADMIN_ID),
    ).resolves.toMatchObject({ status: 'ON_LEAVE' });
    expect(tx.authAccount.updateMany).not.toHaveBeenCalled();
  });

  it('працівника шукає у своїй організації серед невидалених; немає → 404 без запису', async () => {
    prisma.employee.findFirst.mockResolvedValue(null);

    await expect(service.update(ORG, EMP_ID, { status: 'FIRED' }, ADMIN_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.employee.findFirst).toHaveBeenCalledWith({
      where: { id: EMP_ID, orgId: ORG, deletedAt: null },
      select: { id: true, status: true },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// guards: BR-EMP-001
describe('PATCH /employees/:id — контролер передає id поточного користувача', () => {
  let app: INestApplication;
  const serviceMock = { update: vi.fn() };

  beforeEach(async () => {
    serviceMock.update.mockReset();
    const module = await Test.createTestingModule({
      controllers: [EmployeesController],
      providers: [{ provide: EmployeesService, useValue: serviceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => Record<string, unknown> };
        }) => {
          ctx.switchToHttp().getRequest().user = { id: ADMIN_ID, orgId: ORG, role: 'ADMIN' };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const patch = (id: string, body: unknown) =>
    (app as NestFastifyApplication).inject({
      method: 'PATCH',
      url: `/employees/${id}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });

  it('у сервіс іде (orgId, id, dto, id того, хто робить запит)', async () => {
    serviceMock.update.mockResolvedValueOnce(row({ status: 'FIRED' }));

    const res = await patch(EMP_ID, { status: 'FIRED' });

    expect(res.statusCode).toBe(200);
    expect(serviceMock.update).toHaveBeenCalledWith(
      ORG,
      EMP_ID,
      expect.objectContaining({ status: 'FIRED' }),
      ADMIN_ID,
    );
  });

  it('відмова сервісу «не можна звільнити самого себе» доходить клієнту як 400', async () => {
    serviceMock.update.mockRejectedValueOnce(
      new BadRequestException('Не можна звільнити самого себе: це закрило б вам вхід у систему'),
    );

    const res = await patch(ADMIN_ID, { status: 'FIRED' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      message: 'Не можна звільнити самого себе: це закрило б вам вхід у систему',
    });
  });

  it('невідомий статус → 400 ще до сервісу', async () => {
    const res = await patch(EMP_ID, { status: 'RETIRED' });

    expect(res.statusCode).toBe(400);
    expect(serviceMock.update).not.toHaveBeenCalled();
  });
});
