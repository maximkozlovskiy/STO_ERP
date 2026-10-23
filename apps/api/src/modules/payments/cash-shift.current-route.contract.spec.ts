/**
 * HTTP-контракт `GET /cash-shifts/current` (BR-CASH-027): `cashRegisterId` — необов'язковий UUID,
 * що доходить до сервісу; без нього маршрут працює як раніше (стан філії). Логіку вибору зміни
 * стереже `cash-shift.per-register.spec.ts`.
 *
 * Mutation-verify (2026-10-23): контролер не передає `cashRegisterId` у сервіс → кейс «каса
 * доходить до сервісу» червоний; `ParseUUIDPipe` знято → кейс «не UUID → 400» червоний.
 */
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { CashShiftController } from './cash-shift.controller';
import { CashShiftService } from './cash-shift.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const ORG = 'org-1';
const BR = '11111111-1111-4111-8111-111111111111';
const REG = '22222222-2222-4222-8222-222222222222';

const serviceMock = { getCurrent: vi.fn().mockResolvedValue(null) };

describe('GET /cash-shifts/current — HTTP-контракт (BR-CASH-027)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CashShiftController],
      providers: [{ provide: CashShiftService, useValue: serviceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            id: 'emp-1',
            orgId: ORG,
            role: 'RECEPTIONIST',
          };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => serviceMock.getCurrent.mockClear());

  const get = (qs: string) =>
    (app as NestFastifyApplication).inject({ method: 'GET', url: `/cash-shifts/current?${qs}` });

  // guards: BR-CASH-027
  it('каса доходить до сервісу: getCurrent(orgId, branchId, cashRegisterId)', async () => {
    const res = await get(`branchId=${BR}&cashRegisterId=${REG}`);
    expect(res.statusCode).toBe(200);
    expect(serviceMock.getCurrent).toHaveBeenCalledWith(ORG, BR, REG);
  });

  // guards: BR-CASH-027
  it('без каси — як раніше: getCurrent(orgId, branchId, undefined)', async () => {
    const res = await get(`branchId=${BR}`);
    expect(res.statusCode).toBe(200);
    expect(serviceMock.getCurrent).toHaveBeenCalledWith(ORG, BR, undefined);
  });

  it('cashRegisterId не UUID → 400, до сервісу не доходить', async () => {
    const res = await get(`branchId=${BR}&cashRegisterId=abc`);
    expect(res.statusCode).toBe(400);
    expect(serviceMock.getCurrent).not.toHaveBeenCalled();
  });
});
