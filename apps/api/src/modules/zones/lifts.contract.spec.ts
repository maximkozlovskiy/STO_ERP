import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LiftsController } from './zones.controller';
import { ZonesService } from './zones.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

// Контракт-тест навколо Bug #283 — CreateLiftDto.maxWeightKg та UpdateLiftDto.maxWeightKg
// раніше були @IsOptional() БЕЗ типу/діапазону, що пропускало string/NaN/негативні значення.
// Тепер тип Int + Min(0) + Max(50000).

const serviceMock = {
  findAllLifts: vi.fn(),
  findOneLift: vi.fn(),
  createLift: vi.fn(),
  updateLift: vi.fn(),
  removeLift: vi.fn(),
  findAllZones: vi.fn(),
  findOneZone: vi.fn(),
  createZone: vi.fn(),
  updateZone: vi.fn(),
  removeZone: vi.fn(),
};

const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: 'emp-1', orgId: 'org-1', role: 'ADMIN' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

const LIFT_DTO = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: 'org-1',
  zoneId: '22222222-2222-4222-8222-222222222222',
  name: 'Підйомник №1',
  type: 'TWO_POST',
  status: 'ACTIVE',
  maxWeightKg: 3500,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('Lifts — HTTP Contract (Bug #283 regression guard)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [LiftsController],
      providers: [{ provide: ZonesService, useValue: serviceMock }],
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
    await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /lifts — maxWeightKg валідація (Bug #283)', () => {
    it('201 — приймає валідний maxWeightKg=3500 (Int, 0..50000)', async () => {
      serviceMock.createLift.mockResolvedValueOnce(LIFT_DTO);
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/lifts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          zoneId: '22222222-2222-4222-8222-222222222222',
          name: 'Підйомник №1',
          type: 'TWO_POST',
          maxWeightKg: 3500,
        }),
      });
      expect(res.statusCode).toBe(201);
    });

    it('201 — приймає string number "3500" через @Type(() => Number) coercion', async () => {
      serviceMock.createLift.mockResolvedValueOnce(LIFT_DTO);
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/lifts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          zoneId: '22222222-2222-4222-8222-222222222222',
          name: 'Підйомник №1',
          type: 'TWO_POST',
          maxWeightKg: '3500',
        }),
      });
      // class-transformer @Type(() => Number) перетворить "3500" → 3500
      expect(res.statusCode).toBe(201);
    });

    it('400 — відхиляє нечислову строку "abc"', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/lifts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          zoneId: '22222222-2222-4222-8222-222222222222',
          name: 'X',
          type: 'TWO_POST',
          maxWeightKg: 'abc',
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("400 — відхиляє від'ємне значення -100", async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/lifts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          zoneId: '22222222-2222-4222-8222-222222222222',
          name: 'X',
          type: 'TWO_POST',
          maxWeightKg: -100,
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 — відхиляє значення поза верхньою межею (100_000)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/lifts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          zoneId: '22222222-2222-4222-8222-222222222222',
          name: 'X',
          type: 'TWO_POST',
          maxWeightKg: 100000,
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 — відхиляє float 2.5 (потрібен Int)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/lifts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          zoneId: '22222222-2222-4222-8222-222222222222',
          name: 'X',
          type: 'TWO_POST',
          maxWeightKg: 2.5,
        }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('201 — maxWeightKg відсутній (optional) — допустимо', async () => {
      serviceMock.createLift.mockResolvedValueOnce({ ...LIFT_DTO, maxWeightKg: null });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/lifts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          zoneId: '22222222-2222-4222-8222-222222222222',
          name: 'X',
          type: 'TWO_POST',
        }),
      });
      expect(res.statusCode).toBe(201);
    });
  });

  describe('PATCH /lifts/:id — maxWeightKg валідація (Bug #283)', () => {
    it('400 — відхиляє string "abc" в update', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/lifts/${LIFT_DTO.id}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ maxWeightKg: 'abc' }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("400 — відхиляє від'ємне -1", async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/lifts/${LIFT_DTO.id}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ maxWeightKg: -1 }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('200 — приймає валідне 5000', async () => {
      serviceMock.updateLift.mockResolvedValueOnce({ ...LIFT_DTO, maxWeightKg: 5000 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/lifts/${LIFT_DTO.id}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ maxWeightKg: 5000 }),
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
