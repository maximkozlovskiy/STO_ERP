import { ValidationPipe, type ExecutionContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CounterpartiesController } from './counterparties.controller';
import { CounterpartiesService } from './counterparties.service';
import { whereMatches } from '../cash/cash.spec-fixture';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * BR-CP-014 — комірник читає постачальників (рішення власника 2026-10-18, counterparty.md):
 * `GET /counterparties` — лише невидалені SUPPLIER/BOTH своєї організації і лише id, тип, назва,
 * ім'я та ЄДРПОУ; `GET /counterparties/:id/contracts` — лише договори закупівлі постачальника
 * (номер, відстрочка). Клієнтів, телефонів, e-mail, балансів не бачить; запис — 403.
 *
 * RolesGuard — СПРАВЖНІЙ (ролі з `@Roles` контролера), JWT-гард лише підставляє роль. Сервіс —
 * справжній `CounterpartiesService` над таблицями в пам'яті, що ВИКОНУЮТЬ Prisma `where` і
 * `select`: сховище, що ігнорує `select` чи фільтр, сховало б витік полів чи клієнтів.
 */

const ORG = 'org-1';
const SUP = '55555555-5555-4555-8555-000000000001';
const BOTH = '55555555-5555-4555-8555-000000000002';
const CLIENT = '55555555-5555-4555-8555-000000000003';
const SUP_GONE = '55555555-5555-4555-8555-000000000004';
const SUP_FOREIGN = '55555555-5555-4555-8555-000000000005';

type Row = Record<string, unknown>;

function cp(id: string, type: string, over: Row = {}): Row {
  return {
    id,
    orgId: ORG,
    type,
    firstName: null,
    lastName: null,
    companyName: `ТОВ ${id.slice(-1)}`,
    edrpou: `3000000${id.slice(-1)}`,
    vatPayer: true,
    phone: `+38050000000${id.slice(-1)}`,
    email: `cp${id.slice(-1)}@sto.local`,
    notes: 'нотатка',
    legalForm: 'TOV',
    legalAddress: 'Київ',
    actualAddress: 'Київ',
    bankAccount: 'UA00',
    bankName: 'Банк',
    contactPerson: 'Петро',
    taxNumber: '123',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    deletedAt: null,
    settlementAccount: { balance: -1500 },
    statusLinks: [],
    ...over,
  };
}

const COUNTERPARTIES: Row[] = [
  cp(SUP, 'SUPPLIER', { companyName: 'ТОВ Запчастини' }),
  cp(BOTH, 'BOTH', { companyName: 'ФОП Обидва' }),
  cp(CLIENT, 'CLIENT', { companyName: null, firstName: 'Іван', lastName: 'Клієнт' }),
  cp(SUP_GONE, 'SUPPLIER', { deletedAt: new Date('2026-05-01') }),
  cp(SUP_FOREIGN, 'SUPPLIER', { orgId: 'org-2' }),
];

function contract(id: string, counterpartyId: string, over: Row = {}): Row {
  return {
    id,
    orgId: ORG,
    counterpartyId,
    number: `Д-${id}`,
    contractType: 'PURCHASE',
    startDate: new Date('2026-01-01'),
    endDate: new Date('2026-12-31'),
    isPrimary: false,
    creditLimit: 50000,
    currencyCode: 'UAH',
    paymentDeferDays: 14,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    deletedAt: null,
    ...over,
  };
}

const CONTRACTS: Row[] = [
  contract('p1', BOTH, { isPrimary: true }),
  contract('s1', BOTH, { contractType: 'SALE' }),
  contract('p-gone', BOTH, { deletedAt: new Date('2026-05-01') }),
  contract('c1', CLIENT, { contractType: 'SALE' }),
];

// Як Prisma: `select` віддає лише обрані поля, `include` — рядок цілком.
const project = (row: Row, select?: Row) =>
  select ? Object.fromEntries(Object.keys(select).map(k => [k, row[k]])) : row;
const table = (rows: Row[]) => ({
  findMany: vi.fn(async (args: { where?: unknown; select?: Row }) =>
    rows.filter(r => whereMatches(r, args.where)).map(r => project(r, args.select)),
  ),
  findFirst: vi.fn(async (args: { where?: unknown; select?: Row }) => {
    const hit = rows.find(r => whereMatches(r, args.where));
    return hit ? project(hit, args.select) : null;
  }),
  count: vi.fn(
    async (args: { where?: unknown }) => rows.filter(r => whereMatches(r, args.where)).length,
  ),
});

const prisma = {
  counterparty: table(COUNTERPARTIES),
  counterpartyContract: table(CONTRACTS),
};

let role = 'STOREKEEPER';
const jwtGuard = {
  canActivate: vi.fn((ctx: ExecutionContext) => {
    ctx.switchToHttp().getRequest<{ user: unknown }>().user = { id: 'u-1', orgId: ORG, role };
    return true;
  }),
};

const SUPPLIER_FIELDS = ['companyName', 'edrpou', 'firstName', 'id', 'lastName', 'type'];

describe('STOREKEEPER — постачальники для вибору (BR-CP-014)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const service = new CounterpartiesService(
      prisma as unknown as PrismaService,
      null as never, // documentNumberService
      null as never, // audit
      null as never, // counterpartyStatuses
    );
    const module = await Test.createTestingModule({
      controllers: [CounterpartiesController],
      providers: [{ provide: CounterpartiesService, useValue: service }],
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
    role = 'STOREKEEPER';
    prisma.counterparty.findMany.mockClear();
  });

  const get = (url: string) => app.inject({ method: 'GET', url });
  const ids = (res: { json(): unknown }) =>
    (res.json() as { items: Row[] }).items.map(i => i.id).sort();

  // guards: BR-CP-014
  it('GET /counterparties: лише живі постачальники своєї організації (SUPPLIER і BOTH), без клієнтів', async () => {
    const res = await get('/counterparties?limit=200');
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual([SUP, BOTH].sort());
    expect((res.json() as { total: number }).total).toBe(2);
  });

  // guards: BR-CP-014
  it('GET /counterparties: у постачальника лише id, тип, назва, ім’я та ЄДРПОУ — без телефону, e-mail, балансу', async () => {
    const res = await get('/counterparties?types=SUPPLIER&types=BOTH&limit=200');
    const items = (res.json() as { items: Row[] }).items;
    expect(items.length).toBe(2);
    for (const item of items) expect(Object.keys(item).sort()).toEqual(SUPPLIER_FIELDS);
    expect(items.find(i => i.id === SUP)).toEqual({
      id: SUP,
      type: 'SUPPLIER',
      firstName: null,
      lastName: null,
      companyName: 'ТОВ Запчастини',
      edrpou: '30000001',
    });
  });

  // guards: BR-CP-014
  it.each([
    ['types=CLIENT', []],
    ['type=CLIENT', []],
    ['types=CLIENT,SUPPLIER', [SUP]],
    ['types=CLIENT&showDeleted=true', []],
    ['showDeleted=true', [SUP, BOTH]],
  ])('GET /counterparties?%s: параметри лише звужують роль постачальника', async (qs, expected) => {
    const res = await get(`/counterparties?${qs}&limit=200`);
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual([...expected].sort());
  });

  // guards: BR-CP-014
  it.each([
    ['назвою', 'запчаст', [SUP]],
    ['ЄДРПОУ', '30000002', [BOTH]],
    ['телефоном — не шукає', '+380500000001', []],
    ['ім’ям клієнта — не знаходить клієнта', 'Клієнт', []],
  ])('пошук %s', async (_label, q, expected) => {
    const res = await get(`/counterparties?q=${encodeURIComponent(q)}&limit=200`);
    expect(ids(res)).toEqual([...expected].sort());
  });

  // guards: BR-CP-014
  it('сортування за балансом комірнику не діє — порядок за назвою', async () => {
    await get('/counterparties?sortBy=balance&sortDir=desc&limit=200');
    const args = prisma.counterparty.findMany.mock.calls[0]![0] as { orderBy: unknown };
    expect(JSON.stringify(args.orderBy)).not.toContain('settlementAccount');
  });

  // guards: BR-CP-014
  it('GET /counterparties/:id/contracts: лише договори закупівлі — номер і відстрочка', async () => {
    const res = await get(`/counterparties/${BOTH}/contracts?showDeleted=true`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { id: 'p1', number: 'Д-p1', contractType: 'PURCHASE', isPrimary: true, paymentDeferDays: 14 },
    ]);
  });

  // guards: BR-CP-014
  it('GET /counterparties/:id/contracts клієнта → 404: клієнтів комірник не бачить', async () => {
    const res = await get(`/counterparties/${CLIENT}/contracts`);
    expect(res.statusCode).toBe(404);
  });

  // guards: BR-CP-014
  it.each([
    ['GET', `/counterparties/${SUP}`, undefined],
    ['GET', `/counterparties/${SUP}/linked-documents`, undefined],
    ['GET', `/counterparties/${SUP}/garages`, undefined],
    ['POST', '/counterparties', { type: 'SUPPLIER', companyName: 'Новий' }],
    ['PATCH', `/counterparties/${SUP}`, { companyName: 'Інший' }],
    ['DELETE', `/counterparties/${SUP}`, undefined],
    ['POST', `/counterparties/${SUP}/contracts`, { number: 'Д-9' }],
  ] as const)('%s %s → 403 для комірника', async (method, url, payload) => {
    const res = await app.inject({ method, url, ...(payload && { payload }) });
    expect(res.statusCode).toBe(403);
  });

  it('ADMIN — повний список, як раніше (контроль звуження)', async () => {
    role = 'ADMIN';
    const res = await get('/counterparties?limit=200');
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: Row[] }).items;
    expect(items.map(i => i.id).sort()).toEqual([SUP, BOTH, CLIENT].sort());
    expect(items.find(i => i.id === SUP)).toMatchObject({ phone: '+380500000001', balance: -1500 });
  });
});
