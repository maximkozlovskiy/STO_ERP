import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { NbuFetchScheduler } from '../exchange-rates/nbu-fetch.scheduler';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { UI_FEATURES_DEFAULTS } from './settings.dto';

// Mutable Postgres row state across calls — lets us simulate the upsert + read pattern.
let orgRow: {
  orgId: string;
  currency: string;
  vatMode: 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE';
  defaultVatRateId: string | null;
  invoiceDueDays: number;
  autoArchiveDays: number;
  defaultWarrantyDays: number;
  requireClientApproval: boolean;
  allowPartialPayment: boolean;
  brandTheme: string;
  costMethod: 'FIFO' | 'FEFO' | 'LIFO' | 'AVG_COST';
  // Bug #0a / #84: ці поля додані у схему і DTO, але мапінг service.mapOrgSettings
  // тимчасово їх не повертав. Зберігати їх у мок-рядку — і верифікувати у тестах нижче.
  followUpActive: boolean;
  followUpDays: number;
  uiFeatures: Record<string, unknown>;
  updatedAt: Date;
};

function freshOrgRow() {
  orgRow = {
    orgId: 'org-1',
    currency: 'UAH',
    vatMode: 'NONE',
    defaultVatRateId: null,
    invoiceDueDays: 14,
    autoArchiveDays: 90,
    defaultWarrantyDays: 30,
    requireClientApproval: false,
    allowPartialPayment: true,
    brandTheme: 'blue',
    costMethod: 'FIFO',
    followUpActive: false,
    followUpDays: 90,
    uiFeatures: { ...UI_FEATURES_DEFAULTS },
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

const prismaMock = {
  organisationSettings: {
    findUnique: vi.fn().mockImplementation(() => Promise.resolve(orgRow)),
    upsert: vi.fn().mockImplementation(({ update }: { update: Record<string, unknown> }) => {
      // merge incoming update into row, mimic Prisma behaviour
      const next = { ...orgRow, ...update };
      // Json column: replace, do not deep-merge
      if ('uiFeatures' in update) next.uiFeatures = update.uiFeatures as Record<string, unknown>;
      next.updatedAt = new Date();
      orgRow = next as typeof orgRow;
      return Promise.resolve(orgRow);
    }),
  },
  garageBranch: { findFirst: vi.fn() },
  branchSettings: { findUnique: vi.fn(), upsert: vi.fn() },
  // Bug #359/#361: SettingsService.updateOrganisationSettings перевіряє існування
  // currency code у Currency таблиці перед збереженням. Mock повертає row для
  // valid codes (UAH/USD/EUR) і null для unknown.
  currency: {
    findFirst: vi.fn().mockImplementation(({ where }: { where: { code?: string } }) => {
      const validCodes = new Set(['UAH', 'USD', 'EUR']);
      return Promise.resolve(
        where.code && validCodes.has(where.code) ? { id: `cur-${where.code}` } : null,
      );
    }),
  },
};

const redisMock = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
};

let jwtAllow = true;
let userRole: 'OWNER' | 'ADMIN' | 'RECEPTIONIST' = 'OWNER';
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: 'emp-1', orgId: 'org-1', role: userRole };
    return true;
  }),
};
// RolesGuard is overridden to accept all roles in this test — we only test HTTP contract here,
// authorization is verified separately in unit tests.
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

describe('Settings — HTTP Contract', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        SettingsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: REDIS_CLIENT, useValue: redisMock },
        {
          provide: NbuFetchScheduler,
          useValue: { triggerManualFetch: vi.fn(), fetchDaily: vi.fn() },
        },
      ],
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
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jwtAllow = true;
    userRole = 'OWNER';
    freshOrgRow();
    vi.clearAllMocks();
    prismaMock.organisationSettings.findUnique.mockImplementation(() => Promise.resolve(orgRow));
    prismaMock.organisationSettings.upsert.mockImplementation(
      ({ update }: { update: Record<string, unknown> }) => {
        const next = { ...orgRow, ...update };
        if ('uiFeatures' in update) next.uiFeatures = update.uiFeatures as Record<string, unknown>;
        next.updatedAt = new Date();
        orgRow = next as typeof orgRow;
        return Promise.resolve(orgRow);
      },
    );
    redisMock.get.mockResolvedValue(null);
  });

  describe('GET /settings/ui-features', () => {
    it('повертає 200 з усіма 10 boolean ключами UiFeatures', async () => {
      const res = await app.inject({ method: 'GET', url: '/settings/ui-features' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      for (const key of Object.keys(UI_FEATURES_DEFAULTS)) {
        expect(body).toHaveProperty(key);
        expect(typeof body[key]).toBe('boolean');
      }
    });

    it('повертає 403 коли JWT guard відмовив', async () => {
      jwtAllow = false;
      const res = await app.inject({ method: 'GET', url: '/settings/ui-features' });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('PATCH /settings/organisation з uiFeatures', () => {
    it('partial update: вимикає лише один прапор, інші залишаються true', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/organisation',
        payload: { uiFeatures: { toastEnabled: false } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { uiFeatures: Record<string, boolean> };
      expect(body.uiFeatures.toastEnabled).toBe(false);
      // Others must remain at defaults (true)
      expect(body.uiFeatures.unsavedGuardEnabled).toBe(true);
      expect(body.uiFeatures.stockIndicatorEnabled).toBe(true);
      expect(body.uiFeatures.commandPaletteEnabled).toBe(true);
    });

    it('whitelist: невідомі ключі та non-boolean значення відкидаються', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/organisation',
        payload: {
          uiFeatures: {
            toastEnabled: false,
            // junk that must NOT be persisted
            evilKey: 'malicious-string',
            anotherKey: { nested: 'object' },
            stockIndicatorEnabled: 'not-a-boolean',
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { uiFeatures: Record<string, unknown> };
      // toggled key applied
      expect(body.uiFeatures.toastEnabled).toBe(false);
      // junk filtered out
      expect(body.uiFeatures).not.toHaveProperty('evilKey');
      expect(body.uiFeatures).not.toHaveProperty('anotherKey');
      // non-boolean ignored — must keep default true
      expect(body.uiFeatures.stockIndicatorEnabled).toBe(true);
    });

    it('наступний GET /settings/ui-features віддає merged стан', async () => {
      // Bust the cache so we actually re-fetch from Prisma stub.
      redisMock.get.mockResolvedValue(null);
      await app.inject({
        method: 'PATCH',
        url: '/settings/organisation',
        payload: { uiFeatures: { commandPaletteEnabled: false } },
      });
      const res = await app.inject({ method: 'GET', url: '/settings/ui-features' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, boolean>;
      expect(body.commandPaletteEnabled).toBe(false);
      expect(body.toastEnabled).toBe(true);
    });
  });

  describe('GET /settings/organisation', () => {
    it('повертає 200 з uiFeatures всередині shape', async () => {
      const res = await app.inject({ method: 'GET', url: '/settings/organisation' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        orgId: expect.any(String),
        currency: expect.any(String),
        invoiceDueDays: expect.any(Number),
        uiFeatures: expect.any(Object),
      });
    });

    it('повертає costMethod зі значення Prisma enum', async () => {
      const res = await app.inject({ method: 'GET', url: '/settings/organisation' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.costMethod).toBeDefined();
      expect(['FIFO', 'FEFO', 'LIFO', 'AVG_COST']).toContain(body.costMethod);
    });
  });

  describe('PATCH /settings/organisation з costMethod', () => {
    it('приймає AVG_COST і повертає його в response', async () => {
      redisMock.get.mockResolvedValue(null);
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/organisation',
        payload: { costMethod: 'AVG_COST' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { costMethod: string };
      expect(body.costMethod).toBe('AVG_COST');
    });

    it('приймає кожне з валідних значень Prisma enum', async () => {
      for (const method of ['FIFO', 'FEFO', 'LIFO', 'AVG_COST'] as const) {
        const res = await app.inject({
          method: 'PATCH',
          url: '/settings/organisation',
          payload: { costMethod: method },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { costMethod: string };
        expect(body.costMethod).toBe(method);
      }
    });

    it('відхиляє невалідне значення (regression: UI колись слала "AVERAGE")', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/organisation',
        payload: { costMethod: 'AVERAGE' },
      });
      expect(res.statusCode).toBe(400);
    });

    // Bug #265 (regression-guard): UI селект з default `''` для costMethod/vatMode
    // → 200 (не 400). @Transform(emptyToUndefined) → undefined → service залишає поле без змін.
    it('Bug #263: PATCH з costMethod="" → 200 (emptyToUndefined → undefined)', async () => {
      redisMock.get.mockResolvedValue(null);
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/organisation',
        payload: { costMethod: '' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('Bug #263: PATCH з vatMode="" → 200 (emptyToUndefined → undefined)', async () => {
      redisMock.get.mockResolvedValue(null);
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/organisation',
        payload: { vatMode: '' },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // Bug #0a / #84 regression: schema/DTO/service must agree on followUp fields end-to-end.
  // Previously the DTO had the fields, but mapOrgSettings shape did not — TS build broke
  // AND GET returned `undefined` even though DB had real values.
  describe('Bug #84 regression: followUp fields end-to-end', () => {
    it('GET /settings/organisation повертає followUpActive і followUpDays', async () => {
      const res = await app.inject({ method: 'GET', url: '/settings/organisation' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('followUpActive');
      expect(body).toHaveProperty('followUpDays');
      expect(typeof body.followUpActive).toBe('boolean');
      expect(typeof body.followUpDays).toBe('number');
    });

    it('PATCH /settings/organisation приймає followUpActive=true, followUpDays=120', async () => {
      redisMock.get.mockResolvedValue(null);
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/organisation',
        payload: { followUpActive: true, followUpDays: 120 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { followUpActive: boolean; followUpDays: number };
      expect(body.followUpActive).toBe(true);
      expect(body.followUpDays).toBe(120);
    });

    it('PATCH відхиляє followUpDays < 30 (поза межами @Min/@Max)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/organisation',
        payload: { followUpDays: 5 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH відхиляє followUpDays > 365', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/organisation',
        payload: { followUpDays: 999 },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // Bug #364 (regression-guard): currency field у DTO + service guard на існування коду.
  // Cover three scenarios: valid code (200), empty string (200 via emptyToUndefined),
  // unknown code (400). Без цих кейсів refactor що видалить `currency?` з DTO
  // (regression Bug #6f106ac) пройде CI зеленою.
  describe('Bug #359/#364: currency field end-to-end', () => {
    it('PATCH /settings/organisation з currency=USD → 200 + body.currency=USD', async () => {
      redisMock.get.mockResolvedValue(null);
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/organisation',
        payload: { currency: 'USD' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { currency: string };
      expect(body.currency).toBe('USD');
    });

    it('PATCH /settings/organisation з currency="" → 200 (emptyToUndefined)', async () => {
      redisMock.get.mockResolvedValue(null);
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/organisation',
        payload: { currency: '' },
      });
      // toUpperCurrencyCode мапить '' → undefined → @IsOptional пропускає → 200
      expect(res.statusCode).toBe(200);
    });

    it('PATCH /settings/organisation з currency="uah" нормалізує у UAH → 200', async () => {
      // Bug #359: toUpperCurrencyCode у DTO нормалізує до UPPERCASE ПЕРЕД lookup.
      // Currency mock повертає row тільки для UPPERCASE кодів — без normalization
      // буде 400. Перевіряємо що '*uah*' проходить.
      redisMock.get.mockResolvedValue(null);
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/organisation',
        payload: { currency: 'uah' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { currency: string };
      expect(body.currency).toBe('UAH');
    });

    it('PATCH /settings/organisation з currency=XYZ (no row) → 400', async () => {
      redisMock.get.mockResolvedValue(null);
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/organisation',
        payload: { currency: 'XYZ' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH /settings/organisation з currency у 11+ символів → 400 (@MaxLength)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/organisation',
        payload: { currency: 'TOOLONGCODE' }, // 11 chars
      });
      // toUpperCurrencyCode виконує slice(0,10) → 'TOOLONGCOD' (10 chars) → пройде
      // @MaxLength але currency mock поверне null → 400. Допустимо обидва шляхи.
      expect([400]).toContain(res.statusCode);
    });
  });
});
