/**
 * Налаштування філії: секрети провайдерів write-only (BR-PAY-015, TECH-DEBT §8 L588).
 *
 * Аспект: HTTP-контракт `GET / PATCH /settings/branch/:branchId` над рядком `BranchSettings`, у
 * якому збережені всі чотири секрети — `monobankToken`, `checkboxLicenseKey`, `checkboxPinCode`,
 * `smsApiKey`. У JSON-відповіді жодного з них немає — ні ключем, ні значенням; натомість
 * `hasMonobankToken: true`. Так само чистий об'єкт, який іде в Redis: відповідь із кешу — та сама.
 *
 * Сервіс справжній (`mapBranchSettings`), Prisma — заглушка, Redis — словник у пам'яті.
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

const ORG = 'org-1';
const BRANCH = '11111111-1111-4111-8111-111111111111';

/** Секрети рядка: назва поля → значення, яке не має з'явитись у жодній відповіді. */
const SECRETS = {
  monobankToken: 'mono-token-SECRET-1',
  checkboxLicenseKey: 'checkbox-license-SECRET-2',
  checkboxPinCode: 'pin-SECRET-3',
  smsApiKey: 'sms-api-key-SECRET-4',
} as const;

const branchRow = (over: Record<string, unknown> = {}) => ({
  branchId: BRANCH,
  orgId: ORG,
  workStartTime: '09:00',
  workEndTime: '18:00',
  workDays: [1, 2, 3, 4, 5],
  slotDurationMinutes: 60,
  fiscalEnabled: true,
  checkboxApiUrl: 'https://api.checkbox.ua',
  checkboxCashRegisterId: 'cash-1',
  shiftMode: 'MANUAL',
  monobankApiUrl: 'https://api.monobank.ua',
  smsEnabled: true,
  smsProvider: 'turbosms',
  smsSenderName: 'STO',
  syncVersion: BigInt(3),
  updatedAt: new Date('2026-10-26T00:00:00Z'),
  ...SECRETS,
  ...over,
});

const prismaMock = {
  garageBranch: { findFirst: vi.fn() },
  branchSettings: { findUnique: vi.fn(), upsert: vi.fn() },
};

const store = new Map<string, string>();
const redisMock = {
  get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
  set: vi.fn((key: string, value: string) => {
    store.set(key, value);
    return Promise.resolve('OK');
  }),
  del: vi.fn((...keys: string[]) => {
    keys.forEach(k => store.delete(k));
    return Promise.resolve(keys.length);
  }),
};

const jwtGuard = {
  canActivate: (ctx: ExecutionContext) => {
    ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
      sub: 'emp-1',
      orgId: ORG,
      role: 'OWNER',
    };
    return true;
  },
};

/** Жодного секрету в тексті: ні назви поля, ні значення. */
function expectNoSecrets(raw: string): void {
  for (const [field, value] of Object.entries(SECRETS)) {
    expect(raw, field).not.toContain(`"${field}"`);
    expect(raw, field).not.toContain(value);
  }
}

describe('Налаштування філії — секрети провайдерів не віддаються (BR-PAY-015)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        SettingsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: REDIS_CLIENT, useValue: redisMock },
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
    vi.clearAllMocks();
    store.clear();
    prismaMock.garageBranch.findFirst.mockResolvedValue({ id: BRANCH });
    prismaMock.branchSettings.findUnique.mockResolvedValue(branchRow());
    prismaMock.branchSettings.upsert.mockResolvedValue(branchRow());
  });

  const getBranch = () => app.inject({ method: 'GET', url: `/settings/branch/${BRANCH}` });

  // guards: BR-PAY-015
  it('GET з бази: 200, жодного секрету, hasMonobankToken=true; у кеш теж без секретів', async () => {
    const res = await getBranch();

    expect(res.statusCode).toBe(200);
    expectNoSecrets(res.body);
    expect(res.json()).toMatchObject({
      branchId: BRANCH,
      hasMonobankToken: true,
      checkboxApiUrl: 'https://api.checkbox.ua',
      monobankApiUrl: 'https://api.monobank.ua',
      smsProvider: 'turbosms',
    });
    expect(redisMock.set).toHaveBeenCalledTimes(1);
    expectNoSecrets(String(redisMock.set.mock.calls[0]?.[1]));
  });

  // guards: BR-PAY-015
  it('GET з кешу: бази не читає і віддає ту саму відповідь без секретів', async () => {
    const first = await getBranch();
    const second = await getBranch();

    expect(prismaMock.branchSettings.findUnique).toHaveBeenCalledTimes(1);
    expect(redisMock.get).toHaveBeenCalledTimes(2);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expectNoSecrets(second.body);
    expect(second.json()).toMatchObject({ hasMonobankToken: true });
  });

  it.each([
    ['null', null],
    ['порожній рядок', ''],
  ])('токен monobank — %s → hasMonobankToken=false', async (_label, token) => {
    prismaMock.branchSettings.findUnique.mockResolvedValue(branchRow({ monobankToken: token }));

    const res = await getBranch();

    expect(res.json()).toMatchObject({ hasMonobankToken: false });
  });

  // guards: BR-PAY-015
  it('PATCH із секретами в тілі: 200, у відповіді жодного з них, hasMonobankToken=true', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/settings/branch/${BRANCH}`,
      payload: { ...SECRETS, smsSenderName: 'STO' },
    });

    expect(res.statusCode).toBe(200);
    expectNoSecrets(res.body);
    expect(res.json()).toMatchObject({ branchId: BRANCH, hasMonobankToken: true });
    // Секрети записано (write-only), а кеш філії скинуто — наступний GET іде в базу.
    expect(prismaMock.branchSettings.upsert.mock.calls[0]?.[0]).toMatchObject({
      update: SECRETS,
    });
    expect(redisMock.del).toHaveBeenCalled();
  });

  // guards: BR-PAY-015
  it('PATCH без секретів у тілі, а в рядку вони є → відповідь без секретів', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/settings/branch/${BRANCH}`,
      payload: { smsEnabled: false },
    });

    expect(res.statusCode).toBe(200);
    expectNoSecrets(res.body);
    expect(res.json()).toMatchObject({ hasMonobankToken: true });
  });

  // TECH-DEBT F4 (2026-10-29): «Робочі дні» web, онлайн-запис і «Завантаженість» читають ISO 1…7
  // (неділя = 7), а DTO приймав 0…6 — збереження філії з неділею давало 400.
  it('PATCH workDays з неділею (7) → 200; 0 і 8 — 400', async () => {
    const ok = await app.inject({
      method: 'PATCH',
      url: `/settings/branch/${BRANCH}`,
      payload: { workDays: [1, 2, 3, 4, 5, 6, 7] },
    });
    expect(ok.statusCode).toBe(200);
    expect(prismaMock.branchSettings.upsert.mock.calls[0]?.[0]).toMatchObject({
      update: { workDays: [1, 2, 3, 4, 5, 6, 7] },
    });
    for (const bad of [0, 8]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/settings/branch/${BRANCH}`,
        payload: { workDays: [1, bad] },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});
