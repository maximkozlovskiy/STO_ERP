import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BankAccountsController } from './bank-accounts.controller';
import { BankAccountsService } from './bank-accounts.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const serviceMock = {
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
};

let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: 'emp-1', orgId: 'org-1', role: 'ADMIN' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

const VALID_IBAN = 'UA213223130000026007233566001';
const CURRENCY_ID = '11111111-1111-4111-8111-111111111111';

describe('BankAccounts — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BankAccountsController],
      providers: [{ provide: BankAccountsService, useValue: serviceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Mirror production pipe (main.ts) so IBAN @Matches → 400.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jwtAllow = true;
    vi.clearAllMocks();
  });

  describe('GET /bank-accounts', () => {
    it('повертає 200 + { items, total } (не голий масив)', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/bank-accounts',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ items: expect.any(Array), total: expect.any(Number) });
    });

    it('повертає 403 коли guard не пропустив', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/bank-accounts',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /bank-accounts — IBAN валідація', () => {
    it('повертає 400 при невалідному IBAN (не UA / неправильна довжина)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/bank-accounts',
        payload: { name: 'Тест', ibanUA: 'GB29NWBK60161331926819', currencyId: CURRENCY_ID },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.create).not.toHaveBeenCalled();
    });

    it('повертає 400 коли IBAN відсутній', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/bank-accounts',
        payload: { name: 'Тест', currencyId: CURRENCY_ID },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.create).not.toHaveBeenCalled();
    });

    it('повертає 201 + DTO shape при валідному UA IBAN', async () => {
      serviceMock.create.mockResolvedValueOnce({
        id: 'ba-1',
        orgId: 'org-1',
        name: 'Поточний',
        ibanUA: VALID_IBAN,
        currencyId: CURRENCY_ID,
        currencyCode: 'UAH',
        bankName: null,
        branchId: null,
        branchName: null,
        mfo: null,
        edrpou: null,
        bankAddress: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/bank-accounts',
        payload: { name: 'Поточний', ibanUA: VALID_IBAN, currencyId: CURRENCY_ID },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        id: expect.any(String),
        ibanUA: VALID_IBAN,
        currencyCode: 'UAH',
      });
      expect(serviceMock.create).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ ibanUA: VALID_IBAN }),
      );
    });

    // Bug #244 regression-guard: sprint 7f052d5 додав @Transform(emptyToUndefined)
    // саме щоб порожній рядок не давав 400. Якщо @Transform відкатять у refactor
    // — tsc лишиться зеленим, а runtime поверне 400 → фронт ламається.
    it('повертає 201 коли branchId="" (порожній рядок → @Transform(emptyToUndefined) → undefined)', async () => {
      serviceMock.create.mockResolvedValueOnce({
        id: 'ba-1',
        orgId: 'org-1',
        name: 'Поточний',
        ibanUA: VALID_IBAN,
        currencyId: CURRENCY_ID,
        currencyCode: 'UAH',
        bankName: null,
        branchId: null,
        branchName: null,
        mfo: null,
        edrpou: null,
        bankAddress: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/bank-accounts',
        payload: {
          name: 'Поточний',
          ibanUA: VALID_IBAN,
          currencyId: CURRENCY_ID,
          branchId: '',
        },
      });
      expect(res.statusCode).toBe(201);
      // class-transformer прибирає branchId перш ніж DTO потрапить у service
      const dtoArg = serviceMock.create.mock.calls[0]![1] as Record<string, unknown>;
      expect(dtoArg.branchId).toBeUndefined();
    });
  });
});
