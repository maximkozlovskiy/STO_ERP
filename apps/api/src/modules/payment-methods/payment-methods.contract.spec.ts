/**
 * PaymentMethods — HTTP-контракт полів «куди надходять кошти» (`defaultSourceType`,
 * `defaultCashRegisterId`, `defaultBankAccountId`). До 2026-10-14 DTO їх не мав: з глобальним
 * `forbidNonWhitelisted` запит із ними падав 400, тож задати касу за замовчуванням було нічим.
 */
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PaymentMethodsController } from './payment-methods.controller';
import { PaymentMethodsService } from './payment-methods.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';

const serviceMock = {
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
};
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user?: unknown }>();
    req.user = { sub: 'emp-1', orgId: 'org-1', role: 'ADMIN' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

const PM_ID = '11111111-1111-4111-8111-111111111111';
const CASH_ID = '33333333-3333-4333-8333-333333333333';
const BANK_ID = '44444444-4444-4444-8444-444444444444';

describe('PaymentMethods — HTTP Contract (куди надходять кошти)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PaymentMethodsController],
      providers: [{ provide: PaymentMethodsService, useValue: serviceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Як у main.ts: невідоме поле → 400, тож поле, якого DTO не знає, тут же й видно.
    (app as INestApplication).useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    serviceMock.update.mockResolvedValue({ id: PM_ID });
    serviceMock.create.mockResolvedValue({ id: PM_ID });
  });

  const patch = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/payment-methods/${PM_ID}`, payload });

  it('PATCH з касою за замовчуванням → 200, поля доходять до сервісу', async () => {
    const res = await patch({ defaultSourceType: 'CASH_REGISTER', defaultCashRegisterId: CASH_ID });

    expect(res.statusCode).toBe(200);
    expect(serviceMock.update).toHaveBeenCalledWith('org-1', PM_ID, {
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: CASH_ID,
    });
  });

  it('PATCH з null знімає призначення: null доходить до сервісу як null', async () => {
    const res = await patch({
      defaultSourceType: null,
      defaultCashRegisterId: null,
      defaultBankAccountId: null,
    });

    expect(res.statusCode).toBe(200);
    expect(serviceMock.update).toHaveBeenCalledWith('org-1', PM_ID, {
      defaultSourceType: null,
      defaultCashRegisterId: null,
      defaultBankAccountId: null,
    });
  });

  it('POST із банківським рахунком за замовчуванням → 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/payment-methods',
      payload: {
        code: 'card',
        name: 'Картка',
        defaultSourceType: 'BANK_ACCOUNT',
        defaultBankAccountId: BANK_ID,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(serviceMock.create).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ defaultSourceType: 'BANK_ACCOUNT', defaultBankAccountId: BANK_ID }),
    );
  });

  it.each([
    ['невідомий тип', { defaultSourceType: 'SAFE' }],
    ['каса не uuid', { defaultSourceType: 'CASH_REGISTER', defaultCashRegisterId: 'каса-1' }],
    ['рахунок не uuid', { defaultSourceType: 'BANK_ACCOUNT', defaultBankAccountId: '42' }],
  ])('PATCH: %s → 400, сервіс не викликається', async (_label, payload) => {
    const res = await patch(payload);

    expect(res.statusCode).toBe(400);
    expect(serviceMock.update).not.toHaveBeenCalled();
  });

  it('змінювати призначення можуть лише власник і адміністратор', () => {
    const roles = (method: keyof PaymentMethodsController) =>
      new Reflector().get<string[]>(ROLES_KEY, PaymentMethodsController.prototype[method]);

    expect(roles('create')).toEqual(['OWNER', 'ADMIN']);
    expect(roles('update')).toEqual(['OWNER', 'ADMIN']);
    // Список читає й приймальня: вікно оплати рахунку бере з нього касу за замовчуванням.
    expect(roles('findAll')).toEqual(expect.arrayContaining(['RECEPTIONIST', 'ACCOUNTANT']));
  });
});
