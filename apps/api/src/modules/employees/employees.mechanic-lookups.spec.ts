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
  person('mech-1', 'MECHANIC', {
    userId: 'user-mech-1',
    dateOfHire: new Date('2025-02-03'),
    employeeLifts: [{ liftId: 'lift-1' }],
    employeeZones: [{ zoneId: 'zone-1' }],
  }),
  person('mech-gone', 'MECHANIC', { deletedAt: new Date('2026-05-01') }),
  person('mech-fired', 'MECHANIC', { status: 'FIRED', dateOfFire: new Date('2026-06-01') }),
  person('mech-leave', 'MECHANIC', { status: 'ON_LEAVE' }),
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
  syncVersion: 1n,
  updatedAt: new Date('2026-10-01'),
};

const CARD_FIELDS = [
  'currency',
  'defaultVatRateId',
  'language',
  'recalcActualHoursFromLines',
  'recalcPlannedHoursFromLines',
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
// Як Prisma: `select` віддає лише обрані поля. Сховище, що ігнорує `select`, сховало б витік
// полів запитом без нього — саме те, від чого стереже перелік полів механіка.
const project = (row: Record<string, unknown>, select?: Record<string, unknown>) =>
  select ? Object.fromEntries(Object.keys(select).map(k => [k, row[k]])) : row;
const prisma = {
  employee: {
    findMany: vi.fn(
      async (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) =>
        employeeTable(args).map(e => project(e, args.select)),
    ),
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
// Повний рядок договору, як його віддає сервіс решті ролей.
const CONTRACT = {
  id: 'c-1',
  orgId: ORG,
  counterpartyId: CP_ID,
  number: 'Д-1',
  contractType: 'SALE',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  isPrimary: true,
  creditLimit: 50000,
  currencyCode: 'UAH',
  paymentDeferDays: 14,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
};
const counterparties = {
  findContracts: vi.fn().mockResolvedValue([CONTRACT]),
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
    counterparties.findContracts.mockClear();
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

  // ── Рішення власника 2026-10-16, друге (employee.md, «Звуження й приймальня»): приймальня —
  // звужені налаштування й ставки ПДВ; механік — мінімум полів у працівниках і договорах.

  // Комірник — ті самі поля для ПДВ картки замовлення постачальнику (рішення власника 2026-10-18).
  it.each(['RECEPTIONIST', 'STOREKEEPER'])(
    'GET /settings/organisation: %s — лише поля картки (ПДВ організації)',
    async r => {
      role = r;
      const res = await get('/settings/organisation');
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(CARD_FIELDS);
      expect(body).toMatchObject({ vatMode: 'EXCLUSIVE', defaultVatRateId: 'vat-20' });
      expect(body).not.toHaveProperty('laborCostRatio');
      expect(body).not.toHaveProperty('loyaltyEnabled');
      expect(body).not.toHaveProperty('invoiceDueDays');
    },
  );

  it.each(['ADMIN', 'OWNER'])(
    'GET /settings/organisation: %s — повні налаштування, як раніше',
    async r => {
      role = r;
      const body = (await get('/settings/organisation')).json() as Record<string, unknown>;
      expect(body).toHaveProperty('laborCostRatio', 0.4);
      expect(body).toHaveProperty('invoiceDueDays', 7);
    },
  );

  it.each(['RECEPTIONIST', 'STOREKEEPER', 'ACCOUNTANT', 'ADMIN'])(
    'GET /settings/tax-rates → 200 для %s',
    async r => {
      role = r;
      const res = await get('/settings/tax-rates');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        { id: 'vat-20', name: 'ПДВ 20%', rate: 20, isDefault: true, isActive: true },
      ]);
    },
  );

  it.each([
    ['PATCH', '/settings/organisation', { invoiceDueDays: 10 }],
    ['POST', '/settings/tax-rates', { name: 'X', rate: 7 }],
  ] as const)(
    '%s %s → 403 для приймальні й комірника: читання не дає права змінювати',
    async (method, url, payload) => {
      for (const r of ['RECEPTIONIST', 'STOREKEEPER']) {
        role = r;
        const res = await app.inject({ method, url, payload });
        expect(res.statusCode, r).toBe(403);
      }
    },
  );

  it("GET /employees: механіку — лише id, ім'я, прізвище активних механіків", async () => {
    const res = await get('/employees?role=MECHANIC&limit=200');
    const body = res.json() as { items: Record<string, unknown>[]; total: number };
    expect(body.items).toEqual([{ id: 'mech-1', firstName: 'Іван', lastName: 'mech-1' }]);
    expect(body.total).toBe(1);
    const [mech] = body.items;
    for (const field of [
      'phone',
      'email',
      'dateOfHire',
      'dateOfFire',
      'userId',
      'liftIds',
      'zoneIds',
      'workCategoryIds',
      'branchIds',
      'status',
      'role',
      'orgId',
      'rateScheme',
    ])
      expect(mech).not.toHaveProperty(field);
  });

  it('GET /employees: механіку — без звільнених і тих, хто у відпустці', async () => {
    const body = (await get('/employees?limit=200')).json() as { items: { id: string }[] };
    const ids = body.items.map(e => e.id);
    expect(ids).not.toContain('mech-fired');
    expect(ids).not.toContain('mech-leave');
  });

  it.each(['RECEPTIONIST', 'ADMIN'])(
    'GET /employees: %s — повні дані механіків, як раніше (контроль звуження)',
    async r => {
      role = r;
      const body = (await get('/employees?role=MECHANIC&limit=200')).json() as {
        items: Record<string, unknown>[];
      };
      expect(body.items.map(e => e.id)).toEqual(['mech-1', 'mech-fired', 'mech-leave']);
      expect(body.items[0]).toMatchObject({
        phone: '+380501112233',
        email: 'mech-1@sto.local',
        userId: 'user-mech-1',
        status: 'ACTIVE',
        liftIds: ['lift-1'],
      });
      expect(body.items[0]).not.toHaveProperty('rateScheme');
    },
  );

  it('GET /counterparties/:id/contracts: механіку — лише id, номер і тип', async () => {
    const res = await get(`/counterparties/${CP_ID}/contracts?showDeleted=true`);
    expect(res.statusCode).toBe(200);
    const [contract] = res.json() as Record<string, unknown>[];
    expect(contract).toEqual({ id: 'c-1', number: 'Д-1', contractType: 'SALE' });
    for (const field of [
      'creditLimit',
      'paymentDeferDays',
      'currencyCode',
      'startDate',
      'endDate',
      'isPrimary',
      'counterpartyId',
      'orgId',
      'deletedAt',
    ])
      expect(contract).not.toHaveProperty(field);
    // `showDeleted` механіку не діє: видалені договори він не отримує.
    expect(counterparties.findContracts).toHaveBeenCalledWith(ORG, CP_ID, false);
  });

  it.each(['RECEPTIONIST', 'ACCOUNTANT', 'OWNER'])(
    'GET /counterparties/:id/contracts: %s — повний договір, як раніше',
    async r => {
      role = r;
      const res = await get(`/counterparties/${CP_ID}/contracts`);
      expect(res.json()).toEqual([CONTRACT]);
    },
  );
});
