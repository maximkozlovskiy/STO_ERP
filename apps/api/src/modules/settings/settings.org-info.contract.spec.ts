/**
 * НДІ → «Реквізити»: `GET/PATCH /settings/org-info` — телефон, e-mail, ІПН і основний
 * банківський рахунок організації (друкуються в шапці рахунків, нарядів і актів).
 *
 * Аспект: HTTP-контракт через справжній ValidationPipe з фабрикою помилок (тексти 400 —
 * українською) і SettingsService з Prisma-заглушкою. Валідація: телефон `+380XXXXXXXXX`,
 * e-mail, ІПН — 10 або 12 цифр; порожній рядок очищає поле. Основний рахунок має бути своїм і
 * не видаленим — інакше 404 і організація не змінюється. Маршрути — лише OWNER і ADMIN.
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
const OWN_ACCOUNT = '33333333-3333-4333-8333-333333333333';
const FOREIGN_ACCOUNT = '44444444-4444-4444-8444-444444444444';

type OrgRow = {
  id: string;
  orgId: string;
  name: string;
  edrpou: string | null;
  logoUrl: string | null;
  legalAddress: string | null;
  actualAddress: string | null;
  phone: string | null;
  email: string | null;
  ipn: string | null;
  bankAccountId: string | null;
  updatedAt: Date;
};

const baseRow: OrgRow = {
  id: ORG,
  orgId: ORG,
  name: 'СТО Альфа',
  edrpou: '12345678',
  logoUrl: null,
  legalAddress: null,
  actualAddress: null,
  phone: null,
  email: null,
  ipn: null,
  bankAccountId: null,
  updatedAt: new Date('2026-10-15T00:00:00Z'),
};
let orgRow: OrgRow = { ...baseRow };

/** Що сервіс записав в організацію останнім `update`. */
const updatedData = () =>
  (prismaMock.organisation.update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;

const prismaMock = {
  organisation: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  bankAccount: { findFirst: vi.fn() },
};

const jwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx: ExecutionContext) => {
    ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
      sub: 'emp-1',
      orgId: ORG,
      role: 'OWNER',
    };
    return true;
  }),
};

describe('PATCH /settings/org-info — реквізити для друку', () => {
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
        // SettingsService інжектить HOST_LOOKUP (SSRF-перевірка адрес); цей спек DNS не торкає —
        // фейк резолвить у публічну адресу, щоб модуль зібрався (org-info адрес не зберігає).
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
    vi.clearAllMocks();
    orgRow = { ...baseRow };
    prismaMock.organisation.findFirst.mockImplementation(() => Promise.resolve(orgRow));
    prismaMock.organisation.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => {
        orgRow = { ...orgRow, ...data };
        return Promise.resolve(orgRow);
      },
    );
    prismaMock.bankAccount.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === OWN_ACCOUNT ? { id: OWN_ACCOUNT } : null),
    );
  });

  const patch = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/settings/org-info', payload });

  it('телефон, e-mail, ІПН і основний рахунок зберігаються й повертаються', async () => {
    const res = await patch({
      phone: '+380501112233',
      email: 'info@alfa.ua',
      ipn: '123456789012',
      bankAccountId: OWN_ACCOUNT,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      phone: '+380501112233',
      email: 'info@alfa.ua',
      ipn: '123456789012',
      bankAccountId: OWN_ACCOUNT,
    });
    expect(updatedData()).toMatchObject({
      phone: '+380501112233',
      email: 'info@alfa.ua',
      ipn: '123456789012',
      bankAccountId: OWN_ACCOUNT,
    });
  });

  it('GET віддає нові поля', async () => {
    orgRow = { ...orgRow, phone: '+380501112233', email: 'info@alfa.ua', ipn: '1234567890' };
    const res = await app.inject({ method: 'GET', url: '/settings/org-info' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      phone: '+380501112233',
      email: 'info@alfa.ua',
      ipn: '1234567890',
    });
  });

  it.each(['1234567890', '123456789012'])('ІПН із %s цифр приймається', async ipn => {
    expect((await patch({ ipn })).statusCode).toBe(200);
  });

  it.each([
    ['телефон без +380', { phone: '0501112233' }, 'Телефон має бути у форматі +380XXXXXXXXX'],
    ['телефон із пробілами', { phone: '+380 50 111 22 33' }, 'Телефон має бути у форматі'],
    ['e-mail без @', { email: 'info.alfa.ua' }, 'Невірний формат e-mail'],
    ['ІПН з 11 цифр', { ipn: '12345678901' }, 'ІПН має містити 10 або 12 цифр'],
    ['ІПН з літерами', { ipn: '12345678901A' }, 'ІПН має містити 10 або 12 цифр'],
  ])('%s → 400 з українським повідомленням, організація не змінюється', async (_l, body, msg) => {
    const res = await patch(body);

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain(msg);
    expect(prismaMock.organisation.update).not.toHaveBeenCalled();
  });

  it('порожній рядок очищає телефон, e-mail і ІПН (null у базі)', async () => {
    orgRow = { ...orgRow, phone: '+380501112233', email: 'a@b.ua', ipn: '1234567890' };

    const res = await patch({ phone: '', email: '', ipn: '' });

    expect(res.statusCode).toBe(200);
    expect(updatedData()).toMatchObject({
      phone: null,
      email: null,
      ipn: null,
    });
    expect(res.json()).toMatchObject({ phone: null, email: null, ipn: null });
  });

  it('чужий або видалений банківський рахунок → 404, організація не змінюється', async () => {
    const res = await patch({ bankAccountId: FOREIGN_ACCOUNT });

    expect(res.statusCode).toBe(404);
    expect(prismaMock.bankAccount.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: FOREIGN_ACCOUNT, orgId: ORG, deletedAt: null },
    });
    expect(prismaMock.organisation.update).not.toHaveBeenCalled();
  });

  it('bankAccountId: null знімає основний рахунок без перевірки рахунку', async () => {
    orgRow = { ...orgRow, bankAccountId: OWN_ACCOUNT };

    const res = await patch({ bankAccountId: null });

    expect(res.statusCode).toBe(200);
    expect(prismaMock.bankAccount.findFirst).not.toHaveBeenCalled();
    expect(res.json()).toMatchObject({ bankAccountId: null });
  });

  it('GET і PATCH /settings/org-info — лише OWNER і ADMIN', () => {
    const roles = (m: 'getOrgInfo' | 'updateOrgInfo') =>
      [...(Reflect.getMetadata(ROLES_KEY, SettingsController.prototype[m]) as string[])].sort();
    expect(roles('getOrgInfo')).toEqual(['ADMIN', 'OWNER']);
    expect(roles('updateOrgInfo')).toEqual(['ADMIN', 'OWNER']);
  });
});
