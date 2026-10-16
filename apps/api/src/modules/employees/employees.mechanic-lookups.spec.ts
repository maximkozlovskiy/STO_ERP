import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { SettingsController } from '../settings/settings.controller';
import { SettingsService } from '../settings/settings.service';
import { CounterpartiesController } from '../counterparties/counterparties.controller';
import { CounterpartiesService } from '../counterparties/counterparties.service';
import { matchesWhere } from '../calendar/calendar.spec-fixture';

// Читання довідників картки наряду механіком (рішення власника 2026-10-16, docs/objects/employee.md):
// `GET /employees?role=MECHANIC`, `/settings/organisation`, `/settings/tax-rates`,
// `/counterparties/:id/contracts` — 200 для MECHANIC; без ставок (`rateScheme`), без налаштувань
// понад поля картки; змінювати довідники механік не може (403).
//
// RolesGuard — СПРАВЖНІЙ (ролі з `@Roles` контролерів), JWT-гард лише підставляє користувача з
// роллю. Працівники — таблиця в пам'яті, що виконує Prisma `where`; налаштування організації —
// справжній `SettingsService` над повним рядком БД, тож перелік полів у відповіді — справжній.

const ORG = 'org-1';
const CP_ID = '55555555-5555-4555-8555-555555555555';

function person(id: string, role: string, over: Record<string, unknown> = {}) {
  return {
    id,
    orgId: ORG,
    userId: null,
    firstName: 'Іван',
    lastName: id,
    role,
    status: 'ACTIVE',
    phone: '+380501112233',
    email: `${id}@sto.local`,
    dateOfHire: null,
    dateOfFire: null,
    rateScheme: { type: 'HOURLY', rate: 250 },
    allBranches: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    deletedAt: null as Date | null,
    employeeLifts: [],
    employeeZones: [],
    employeeWorkCategories: [],
    employeeBranches: [],
    ...over,
  };
}

const EMPLOYEES = [
  person('mech-1', 'MECHANIC'),
  person('mech-gone', 'MECHANIC', { deletedAt: new Date('2026-05-01') }),
  person('owner-1', 'OWNER'),
  person('acc-1', 'ACCOUNTANT'),
];

const ORG_SETTINGS_ROW = {
  orgId: ORG,
  currency: 'UAH',
  vatMode: 'EXCLUSIVE',
  defaultVatRateId: 'vat-20',
  invoiceDueDays: 7,
  autoArchiveDays: 30,
  defaultWarrantyDays: 30,
  requireClientApproval: true,
  allowPartialPayment: true,
  brandTheme: 'blue',
  language: 'uk',
  costMethod: 'FIFO',
  followUpActive: false,
  followUpDays: 90,
  maintenanceForecastDays: 14,
  nbuFetchHour: 12,
  deliveryPollIntervalMinutes: 30,
  bankStatementPollIntervalMinutes: 60,
  integrationLogRetentionDays: 30,
  deadLetterRetentionDays: 180,
  laborCostRatio: 0.4,
  uiFeatures: {},
  loyaltyEnabled: true,
  loyaltyEarnPer: 100,
  loyaltyEarnPoints: 1,
  loyaltyRedeemRate: 1,
  recalcPlannedHoursFromLines: true,
  recalcActualHoursFromLines: false,
  syncCalendarSlotWithPlannedHours: true,
  syncVersion: 1n,
  updatedAt: new Date('2026-10-01'),
};

const CARD_FIELDS = [
  'currency',
  'defaultVatRateId',
  'language',
  'recalcActualHoursFromLines',
  'recalcPlannedHoursFromLines',
  'syncCalendarSlotWithPlannedHours',
  'vatMode',
];

let role = 'MECHANIC';
const jwtGuard = {
  canActivate: vi.fn(ctx => {
    ctx.switchToHttp().getRequest().user = { id: 'u-1', orgId: ORG, role };
    return true;
  }),
};

const employeeTable = (args: { where: Record<string, unknown> }) =>
  EMPLOYEES.filter(e => matchesWhere(e, args.where));
const prisma = {
  employee: {
    findMany: vi.fn(async (args: { where: Record<string, unknown> }) => employeeTable(args)),
    count: vi.fn(async (args: { where: Record<string, unknown> }) => employeeTable(args).length),
  },
  organisationSettings: { findUnique: vi.fn().mockResolvedValue(ORG_SETTINGS_ROW) },
  taxRate: {
    findMany: vi
      .fn()
      .mockResolvedValue([
        { id: 'vat-20', name: 'ПДВ 20%', rate: 20, isDefault: true, isActive: true },
      ]),
  },
};
const redis = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK') };
const counterparties = {
  findContracts: vi.fn().mockResolvedValue([{ id: 'c-1', number: 'Д-1', isPrimary: true }]),
  createContract: vi.fn(),
};

describe('MECHANIC — читання довідників картки наряду (employee.md, рішення 2026-10-16)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const settings = new SettingsService(
      prisma as any,
      redis as any,
      null as never,
      null as never,
      null as never,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const employees = new EmployeesService(prisma as any);
    const module = await Test.createTestingModule({
      controllers: [EmployeesController, SettingsController, CounterpartiesController],
      providers: [
        { provide: EmployeesService, useValue: employees },
        { provide: SettingsService, useValue: settings },
        { provide: CounterpartiesService, useValue: counterparties },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(jwtGuard)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    role = 'MECHANIC';
  });

  const get = (url: string) => app.inject({ method: 'GET', url });

  it.each([
    '/employees?role=MECHANIC&limit=200',
    '/settings/organisation',
    '/settings/tax-rates',
    `/counterparties/${CP_ID}/contracts`,
  ])('GET %s → 200 для механіка', async url => {
    const res = await get(url);
    expect(res.statusCode).toBe(200);
  });

  it('GET /employees: механік отримує лише живих механіків без ставок — навіть із role=OWNER і showDeleted', async () => {
    const res = await get('/employees?role=OWNER&showDeleted=true&limit=200');
    const body = res.json() as { items: Record<string, unknown>[] };
    expect(body.items.map(e => e.id)).toEqual(['mech-1']);
    expect(body.items[0]).not.toHaveProperty('rateScheme');
  });

  it('GET /employees: приймальня бачить запитаний список як і раніше (контроль обмеження)', async () => {
    role = 'RECEPTIONIST';
    const res = await get('/employees?role=OWNER&limit=200');
    const body = res.json() as { items: Record<string, unknown>[] };
    expect(body.items.map(e => e.id)).toEqual(['owner-1']);
    expect(body.items[0]).not.toHaveProperty('rateScheme');
  });

  it('GET /settings/organisation: механіку — лише поля картки наряду', async () => {
    const res = await get('/settings/organisation');
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(CARD_FIELDS);
    expect(body).toMatchObject({ vatMode: 'EXCLUSIVE', defaultVatRateId: 'vat-20' });
    expect(body).not.toHaveProperty('laborCostRatio');
    expect(body).not.toHaveProperty('loyaltyEarnPer');
  });

  it('GET /settings/organisation: власнику — повні налаштування (контроль звуження)', async () => {
    role = 'OWNER';
    const res = await get('/settings/organisation');
    const body = res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('laborCostRatio', 0.4);
    expect(Object.keys(body).length).toBeGreaterThan(CARD_FIELDS.length);
  });

  it('GET /settings/tax-rates: лише id, назва, ставка й прапорці', async () => {
    const res = await get('/settings/tax-rates');
    expect(res.json()).toEqual([
      { id: 'vat-20', name: 'ПДВ 20%', rate: 20, isDefault: true, isActive: true },
    ]);
  });

  it.each([
    ['POST', '/settings/tax-rates', { name: 'X', rate: 7 }],
    ['PATCH', '/settings/organisation', { invoiceDueDays: 10 }],
    ['POST', `/counterparties/${CP_ID}/contracts`, { number: 'Д-2' }],
  ] as const)('%s %s → 403: змінювати довідники механік не може', async (method, url, payload) => {
    const res = await app.inject({ method, url, payload });
    expect(res.statusCode).toBe(403);
    expect(counterparties.createContract).not.toHaveBeenCalled();
  });
});
