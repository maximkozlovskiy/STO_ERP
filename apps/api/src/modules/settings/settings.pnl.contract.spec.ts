/**
 * Налаштування звіту P&L (BR-RPT-030, рішення власника 2026-10-29: «винеси в налаштування звіту»):
 * `PATCH /settings/organisation` з полями `pnlIncomeCashReasons` / `pnlExpenseCashReasons` /
 * `pnlWarnFuturePayroll`.
 *
 * Аспект: HTTP-контракт через справжній ValidationPipe з фабрикою помилок і SettingsService з
 * Prisma-заглушкою. Приймаються лише приводи з `PNL_*_CASH_REASON_OPTIONS` (виплата зарплати,
 * оплата постачальнику, повернення клієнту — ні: вони вже в P&L), «Витрата» завжди серед витрат,
 * повтори — ні. Відповідь і GET несуть збережені значення; рядок без полів — типові.
 *
 * Mutation-verify (2026-10-29): прибрати `@IsIn(PNL_INCOME…, { each })` → падає «PAYROLL у доходах»;
 * прибрати `@ArrayContains([EXPENSE])` → падає «без EXPENSE»; прибрати поля з `mapOrgSettings` →
 * падає «відповідь несе значення».
 */
import { ValidationPipe, type ExecutionContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { validationExceptionFactory } from '../../common/pipes/validation-error.factory';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { NbuFetchScheduler } from '../exchange-rates/nbu-fetch.scheduler';
import { BankStatementPullScheduler } from '../bank-statements/bank-statement-pull.scheduler';
import { AuditService } from '../audit/audit.service';
import { HOST_LOOKUP } from '../../common/utils/host-lookup.token';
import { publicHostLookup } from '../../common/testing/host-lookup';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';

const ORG = 'org-1';

/** Рядок налаштувань: лише поля, які читає `mapOrgSettings` (решта — undefined, як «старий» рядок). */
let row: Record<string, unknown> = {};
const baseRow = () => ({
  orgId: ORG,
  currency: 'UAH',
  vatMode: 'NONE',
  laborCostRatio: 0.4,
  loyaltyEarnPer: 100,
  loyaltyEarnPoints: 1,
  loyaltyRedeemRate: 1,
  supplierOptimalPriceWeight: 0.5,
  uiFeatures: {},
  updatedAt: new Date('2026-10-29T00:00:00Z'),
});

const prismaMock = {
  organisationSettings: {
    findUnique: vi.fn(() => Promise.resolve(row)),
    upsert: vi.fn(({ update }: { update: Record<string, unknown> }) => {
      row = { ...row, ...update };
      return Promise.resolve(row);
    }),
  },
};

const jwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx: ExecutionContext) => {
    ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
      id: 'emp-1',
      sub: 'emp-1',
      orgId: ORG,
      role: 'OWNER',
    };
    return true;
  }),
};

describe('PATCH /settings/organisation — налаштування звіту P&L (BR-RPT-030)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        SettingsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: REDIS_CLIENT, useValue: { get: vi.fn(), set: vi.fn(), del: vi.fn() } },
        { provide: NbuFetchScheduler, useValue: {} },
        { provide: BankStatementPullScheduler, useValue: {} },
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        { provide: HOST_LOOKUP, useValue: publicHostLookup },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(jwtGuard)
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        exceptionFactory: validationExceptionFactory,
      }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    prismaMock.organisationSettings.upsert.mockClear();
    row = baseRow();
  });

  const patch = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/settings/organisation', payload });
  const message = (res: { json: () => unknown }) => JSON.stringify(res.json());

  // guards: BR-RPT-030
  it('дозволені приводи й прапорець зберігаються; відповідь і GET несуть значення', async () => {
    const res = await patch({
      pnlIncomeCashReasons: ['MANUAL_IN', 'SALE_PAYMENT'],
      pnlExpenseCashReasons: ['EXPENSE', 'ADVANCE_ISSUE'],
      pnlWarnFuturePayroll: true,
    });

    expect(res.statusCode).toBe(200);
    expect(prismaMock.organisationSettings.upsert.mock.calls[0]?.[0]).toMatchObject({
      where: { orgId: ORG },
      update: {
        pnlIncomeCashReasons: ['MANUAL_IN', 'SALE_PAYMENT'],
        pnlExpenseCashReasons: ['EXPENSE', 'ADVANCE_ISSUE'],
        pnlWarnFuturePayroll: true,
      },
    });
    expect(res.json()).toMatchObject({
      pnlIncomeCashReasons: ['MANUAL_IN', 'SALE_PAYMENT'],
      pnlExpenseCashReasons: ['EXPENSE', 'ADVANCE_ISSUE'],
      pnlWarnFuturePayroll: true,
    });
    const got = await app.inject({ method: 'GET', url: '/settings/organisation' });
    expect(got.json()).toMatchObject({ pnlExpenseCashReasons: ['EXPENSE', 'ADVANCE_ISSUE'] });
  });

  // guards: BR-RPT-030
  it('порожні «інші доходи» дозволені (жодне надходження не є доходом)', async () => {
    const res = await patch({ pnlIncomeCashReasons: [] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pnlIncomeCashReasons: [] });
  });

  // guards: BR-RPT-030
  it.each([
    ['PAYROLL у доходах', { pnlIncomeCashReasons: ['PAYROLL'] }],
    ['видача у доходах', { pnlIncomeCashReasons: ['MANUAL_OUT'] }],
    ['інкасація у доходах', { pnlIncomeCashReasons: ['COLLECTION'] }],
    ['PAYROLL у витратах', { pnlExpenseCashReasons: ['EXPENSE', 'PAYROLL'] }],
    ['оплата постачальнику у витратах', { pnlExpenseCashReasons: ['EXPENSE', 'SUPPLIER_PAYMENT'] }],
    ['повернення клієнту у витратах', { pnlExpenseCashReasons: ['EXPENSE', 'REFUND'] }],
    ['повтор приводу', { pnlIncomeCashReasons: ['MANUAL_IN', 'MANUAL_IN'] }],
    ['не масив', { pnlIncomeCashReasons: 'MANUAL_IN' }],
    ['прапорець — не boolean', { pnlWarnFuturePayroll: 'так' }],
  ])('недоступне значення — 400, налаштування не змінюються (%s)', async (_name, payload) => {
    const res = await patch(payload);
    expect(res.statusCode).toBe(400);
    expect(prismaMock.organisationSettings.upsert).not.toHaveBeenCalled();
  });

  // guards: BR-RPT-030
  it('«Витрата» не знімається: витрати без EXPENSE — 400 з поясненням українською', async () => {
    const res = await patch({ pnlExpenseCashReasons: ['MANUAL_OUT'] });
    expect(res.statusCode).toBe(400);
    expect(message(res)).toContain('«Витрата»');
    expect(prismaMock.organisationSettings.upsert).not.toHaveBeenCalled();
  });

  // guards: BR-RPT-030
  it('рядок без полів P&L (до міграції / старий кеш) — типові значення', async () => {
    const got = await app.inject({ method: 'GET', url: '/settings/organisation' });
    expect(got.json()).toMatchObject({
      pnlIncomeCashReasons: ['MANUAL_IN'],
      pnlExpenseCashReasons: ['EXPENSE'],
      pnlWarnFuturePayroll: false,
    });
  });

  // guards: BR-RPT-030
  it('PATCH /settings/organisation — лише OWNER і ADMIN', () => {
    const roles = [
      ...(Reflect.getMetadata(
        ROLES_KEY,
        SettingsController.prototype.updateOrganisation,
      ) as string[]),
    ].sort();
    expect(roles).toEqual(['ADMIN', 'OWNER']);
  });
});
