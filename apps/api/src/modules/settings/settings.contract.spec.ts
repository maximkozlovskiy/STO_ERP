import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { NbuFetchScheduler } from '../exchange-rates/nbu-fetch.scheduler';
import { AuditService } from '../audit/audit.service';
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
  // Bug #446: нові boolean-поля додані у DTO + service mapping (commit 307d1e39).
  // Мають бути у моку — інакше mapOrgSettings повертає undefined → contract test fail.
  recalcPlannedHoursFromLines: boolean;
  // commit 5d526ba9: recalcActualHoursFromLines додано у DTO + service mapping.
  // Той самий патерн що й Bug #446 — без нього contract test silently повертає
  // undefined у GET /settings/organisation для нового поля.
  recalcActualHoursFromLines: boolean;
  syncCalendarSlotWithPlannedHours: boolean;
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
    recalcPlannedHoursFromLines: true,
    recalcActualHoursFromLines: true,
    syncCalendarSlotWithPlannedHours: true,
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
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
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

  // Bug #446 regression-guard: syncCalendarSlotWithPlannedHours (commit 307d1e39)
  // — нове boolean-поле у DTO + service mapping. Без contract-тестів refactor
  // що видалить його з DTO/whitelist пройде CI зеленим, а frontend (CreateWorkOrderModal
  // зчитує цей флаг з /settings/organisation) silently повернеться на default true.
  describe('Bug #446: syncCalendarSlotWithPlannedHours end-to-end', () => {
    it('PATCH /settings/organisation з syncCalendarSlotWithPlannedHours=false → 200 + body.syncCalendarSlotWithPlannedHours=false', async () => {
      redisMock.get.mockResolvedValue(null);
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/organisation',
        payload: { syncCalendarSlotWithPlannedHours: false },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { syncCalendarSlotWithPlannedHours: boolean };
      expect(body.syncCalendarSlotWithPlannedHours).toBe(false);
    });

    it('PATCH /settings/organisation з syncCalendarSlotWithPlannedHours="not-boolean" → 400', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/organisation',
        payload: { syncCalendarSlotWithPlannedHours: 'yes' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('GET /settings/organisation повертає syncCalendarSlotWithPlannedHours boolean', async () => {
      const res = await app.inject({ method: 'GET', url: '/settings/organisation' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('syncCalendarSlotWithPlannedHours');
      expect(typeof body.syncCalendarSlotWithPlannedHours).toBe('boolean');
    });
  });

  describe('Bug #515-#516: GET /settings/work-hours regression guards', () => {
    it('повертає 200 + default {9, 18} коли BranchSettings відсутній', async () => {
      prismaMock.branchSettings.findFirst = vi.fn().mockResolvedValue(null);
      const res = await app.inject({ method: 'GET', url: '/settings/work-hours' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { workStartHour: number; workEndHour: number };
      expect(body).toEqual({ workStartHour: 9, workEndHour: 18 });
    });

    it('повертає {8, 20} коли settings має workStartTime="08:00", workEndTime="20:00"', async () => {
      prismaMock.branchSettings.findFirst = vi
        .fn()
        .mockResolvedValue({ workStartTime: '08:00', workEndTime: '20:00' });
      const res = await app.inject({ method: 'GET', url: '/settings/work-hours' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ workStartHour: 8, workEndHour: 20 });
    });

    it('повертає workStartHour=0 коли workStartTime="00:00" (parseInt edge case)', async () => {
      prismaMock.branchSettings.findFirst = vi
        .fn()
        .mockResolvedValue({ workStartTime: '00:00', workEndTime: '12:00' });
      const res = await app.inject({ method: 'GET', url: '/settings/work-hours' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ workStartHour: 0, workEndHour: 12 });
    });

    it('Bug #515 defense-in-depth: повертає fallback {9, 18} коли БД має інвертовані часи', async () => {
      // Legacy/corrupt data — до додавання @Matches regex міг бути workStart=20, workEnd=9.
      prismaMock.branchSettings.findFirst = vi
        .fn()
        .mockResolvedValue({ workStartTime: '20:00', workEndTime: '09:00' });
      const res = await app.inject({ method: 'GET', url: '/settings/work-hours' });
      expect(res.statusCode).toBe(200);
      // workEndHour <= workStartHour → service повертає fallback щоб уникнути NaN на frontend.
      expect(res.json()).toEqual({ workStartHour: 9, workEndHour: 18 });
    });

    it('повертає fallback коли workStartTime — невалідний рядок (legacy data до Bug #515 regex)', async () => {
      prismaMock.branchSettings.findFirst = vi
        .fn()
        .mockResolvedValue({ workStartTime: 'foo', workEndTime: 'bar' });
      const res = await app.inject({ method: 'GET', url: '/settings/work-hours' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ workStartHour: 9, workEndHour: 18 });
    });

    it('доступний для RECEPTIONIST/MECHANIC ролей (не лише OWNER/ADMIN)', async () => {
      // mockRolesGuard повертає true для усіх — перевіряємо що handler не падає бо
      // ролі MECHANIC/RECEPTIONIST явно у @Roles() списку нового endpoint.
      userRole = 'RECEPTIONIST';
      prismaMock.branchSettings.findFirst = vi
        .fn()
        .mockResolvedValue({ workStartTime: '09:00', workEndTime: '18:00' });
      const res = await app.inject({ method: 'GET', url: '/settings/work-hours' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('Bug #515: PATCH /settings/branch/:id workStartTime/workEndTime validation', () => {
    const branchId = '11111111-1111-4111-8111-111111111111';

    it('PATCH з workStartTime="25:99" → 400 (Matches HH:MM regex)', async () => {
      prismaMock.garageBranch.findFirst.mockResolvedValue({ id: branchId });
      const res = await app.inject({
        method: 'PATCH',
        url: `/settings/branch/${branchId}`,
        payload: { workStartTime: '25:99' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { message: string | string[] };
      const msg = Array.isArray(body.message) ? body.message.join('; ') : body.message;
      expect(msg).toMatch(/ГГ:ХХ/);
    });

    it('PATCH з workStartTime="foo" → 400', async () => {
      prismaMock.garageBranch.findFirst.mockResolvedValue({ id: branchId });
      const res = await app.inject({
        method: 'PATCH',
        url: `/settings/branch/${branchId}`,
        payload: { workStartTime: 'foo' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH з валідним "09:00"/"18:00" → 200 cross-field check passes', async () => {
      prismaMock.garageBranch.findFirst.mockResolvedValue({ id: branchId });
      prismaMock.branchSettings.findUnique = vi
        .fn()
        .mockResolvedValue({ workStartTime: '08:00', workEndTime: '20:00' });
      prismaMock.branchSettings.upsert = vi.fn().mockResolvedValue({
        branchId,
        orgId: 'org-1',
        workStartTime: '09:00',
        workEndTime: '18:00',
        workDays: [1, 2, 3, 4, 5],
        slotDurationMinutes: 60,
        fiscalEnabled: false,
        checkboxApiUrl: null,
        checkboxCashRegisterId: null,
        smsEnabled: false,
        smsProvider: null,
        smsSenderName: null,
        updatedAt: new Date(),
      });
      const res = await app.inject({
        method: 'PATCH',
        url: `/settings/branch/${branchId}`,
        payload: { workStartTime: '09:00', workEndTime: '18:00' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('PATCH з workStartTime="20:00", workEndTime="09:00" → 400 (cross-field: end <= start)', async () => {
      prismaMock.garageBranch.findFirst.mockResolvedValue({ id: branchId });
      prismaMock.branchSettings.findUnique = vi
        .fn()
        .mockResolvedValue({ workStartTime: '08:00', workEndTime: '20:00' });
      const res = await app.inject({
        method: 'PATCH',
        url: `/settings/branch/${branchId}`,
        payload: { workStartTime: '20:00', workEndTime: '09:00' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { message: string };
      expect(body.message).toMatch(/після часу початку/);
    });

    it('PATCH тільки workEndTime="08:00" коли current workStartTime="09:00" → 400 (merged compare)', async () => {
      prismaMock.garageBranch.findFirst.mockResolvedValue({ id: branchId });
      prismaMock.branchSettings.findUnique = vi
        .fn()
        .mockResolvedValue({ workStartTime: '09:00', workEndTime: '18:00' });
      const res = await app.inject({
        method: 'PATCH',
        url: `/settings/branch/${branchId}`,
        payload: { workEndTime: '08:00' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // Bug #666 (regression-guard): POST /settings/branch/:id/fiscal/verify — новий endpoint
  // (feat(prro): Checkbox ПРРО Крок 1). Контракт: ParseUUIDPipe на branchId, VerifyFiscalDto
  // (whitelist → зайві поля 400), делегує у service.verifyFiscal, повертає {valid,...}.
  // fetch мокнутий — зовнішній виклик не робиться.
  describe('Bug #666: POST /settings/branch/:id/fiscal/verify contract', () => {
    const branchId = '11111111-1111-4111-8111-111111111111';
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      prismaMock.garageBranch.findFirst.mockResolvedValue({ id: branchId });
      prismaMock.branchSettings.findFirst = vi.fn().mockResolvedValue({
        checkboxLicenseKey: 'stored',
        checkboxApiUrl: 'https://api.checkbox.ua',
      });
      fetchSpy = vi.spyOn(global, 'fetch');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('POST з валідним body → 200 + {valid:true, cashRegisterName}', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ results: [{ title: 'Каса №1' }] }), { status: 200 }),
      );
      const res = await app.inject({
        method: 'POST',
        url: `/settings/branch/${branchId}/fiscal/verify`,
        payload: { apiUrl: 'https://api.checkbox.ua', licenseKey: 'k' },
      });
      expect(res.statusCode).toBe(201); // POST default success — Nest/Fastify
      const body = res.json() as { valid: boolean; cashRegisterName?: string };
      expect(body.valid).toBe(true);
      expect(body.cashRegisterName).toBe('Каса №1');
    });

    it('POST без тіла (порожній) → бере збережений ключ → 201', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
      const res = await app.inject({
        method: 'POST',
        url: `/settings/branch/${branchId}/fiscal/verify`,
        payload: {},
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { valid: boolean };
      expect(body.valid).toBe(true);
    });

    it('POST з невалідним UUID branchId → 400 (ParseUUIDPipe)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/settings/branch/not-a-uuid/fiscal/verify`,
        payload: { licenseKey: 'k' },
      });
      expect(res.statusCode).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('POST з зайвим полем → 400 (whitelist forbidNonWhitelisted)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/settings/branch/${branchId}/fiscal/verify`,
        payload: { licenseKey: 'k', evilField: 'x' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST з licenseKey не-рядком → 400 (@IsString)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/settings/branch/${branchId}/fiscal/verify`,
        payload: { licenseKey: 123 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('невідома філія → 404', async () => {
      prismaMock.garageBranch.findFirst.mockResolvedValue(null);
      const res = await app.inject({
        method: 'POST',
        url: `/settings/branch/${branchId}/fiscal/verify`,
        payload: { licenseKey: 'k' },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
