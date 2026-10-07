import type { INestApplication } from '@nestjs/common';
import { NotFoundException, ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';

/**
 * HTTP-контракт `GET /vehicles/:id/mileage` (BR-VEH-004 + ролі з таблиці API у досьє авто).
 *
 * RolesGuard тут СПРАВЖНІЙ (не підмінений): саме він читає `@Roles(...)` з обробника, тож
 * кейси ролей перевіряють декоратор на endpoint-і, а не мок. Підмінено лише JwtAuthGuard —
 * він кладе у запит користувача з роллю, яку задає тест. Сервіс — мок: що він рахує,
 * стереже `vehicles.mileage-history.spec.ts`.
 *
 * UUID у фікстурах — валідний v4: ParseUUIDPipe відхиляє інші значення з 400.
 */

const VEHICLE_ID = '11111111-1111-4111-8111-111111111111';

const serviceMock = {
  getMileageHistory: vi.fn(),
  findOne: vi.fn(),
};

let jwtAllow = true;
let role = 'ADMIN';
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { id: 'emp-1', orgId: 'org-1', role };
    return true;
  }),
};

describe('Vehicles — HTTP Contract: GET /vehicles/:id/mileage', () => {
  let app: INestApplication;

  const get = (url: string) => (app as NestFastifyApplication).inject({ method: 'GET', url });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [VehiclesController],
      providers: [
        { provide: VehiclesService, useValue: serviceMock },
        { provide: PrismaService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
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

  beforeEach(() => {
    jwtAllow = true;
    role = 'ADMIN';
    serviceMock.getMileageHistory.mockReset();
    serviceMock.findOne.mockReset();
  });

  it('200: голий масив записів як є; сервіс отримує orgId із токена та id зі шляху', async () => {
    const points = [
      {
        workOrderId: '22222222-2222-4222-8222-222222222222',
        workOrderNumber: 'НРД-2026-000001',
        date: '2026-09-01T00:00:00.000Z',
        mileage: 0,
        isRollback: false,
      },
    ];
    serviceMock.getMileageHistory.mockResolvedValueOnce(points);

    const res = await get(`/vehicles/${VEHICLE_ID}/mileage`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(points); // масив, не { items, total }; пробіг 0 не губиться
    expect(serviceMock.getMileageHistory).toHaveBeenCalledWith('org-1', VEHICLE_ID);
  });

  it('маршрут /:id/mileage не перехоплюється GET /:id', async () => {
    serviceMock.getMileageHistory.mockResolvedValueOnce([]);

    const res = await get(`/vehicles/${VEHICLE_ID}/mileage`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(serviceMock.findOne).not.toHaveBeenCalled();
  });

  it.each(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC'])('роль %s → 200', async allowed => {
    role = allowed;
    serviceMock.getMileageHistory.mockResolvedValueOnce([]);

    const res = await get(`/vehicles/${VEHICLE_ID}/mileage`);

    expect(res.statusCode).toBe(200);
  });

  it.each(['STOREKEEPER', 'ACCOUNTANT', 'XLSX_MANAGER', 'CLIENT'])(
    'роль %s → 403, сервіс не викликається',
    async denied => {
      role = denied;

      const res = await get(`/vehicles/${VEHICLE_ID}/mileage`);

      expect(res.statusCode).toBe(403);
      expect(serviceMock.getMileageHistory).not.toHaveBeenCalled();
    },
  );

  it('JwtAuthGuard відмовив (немає сесії) → запит не доходить до сервісу', async () => {
    jwtAllow = false;

    const res = await get(`/vehicles/${VEHICLE_ID}/mileage`);

    expect(res.statusCode).toBe(403);
    expect(serviceMock.getMileageHistory).not.toHaveBeenCalled();
  });

  it.each(['not-a-uuid', '123', '11111111-1111-1111-1111-11111111111'])(
    'id "%s" не UUID → 400, сервіс не викликається',
    async bad => {
      const res = await get(`/vehicles/${bad}/mileage`);

      expect(res.statusCode).toBe(400);
      expect(serviceMock.getMileageHistory).not.toHaveBeenCalled();
    },
  );

  // guards: BR-VEH-004
  it('авто чужої org / видалене: NotFoundException сервісу → 404 з його текстом', async () => {
    serviceMock.getMileageHistory.mockRejectedValueOnce(
      new NotFoundException('Автомобіль не знайдено'),
    );

    const res = await get(`/vehicles/${VEHICLE_ID}/mileage`);

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Автомобіль не знайдено');
  });
});
