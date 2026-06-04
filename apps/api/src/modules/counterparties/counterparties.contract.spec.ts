import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CounterpartiesController } from './counterparties.controller';
import { CounterpartiesService } from './counterparties.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const serviceMock = {
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  findGarages: vi.fn(),
  createGarage: vi.fn(),
  removeGarage: vi.fn(),
  findContracts: vi.fn(),
  createContract: vi.fn(),
  updateContract: vi.fn(),
  removeContract: vi.fn(),
};

let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { id: 'emp-1', orgId: 'org-1', role: 'ADMIN' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

describe('Counterparties — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CounterpartiesController],
      providers: [
        { provide: CounterpartiesService, useValue: serviceMock },
        { provide: PrismaService, useValue: {} },
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
    await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /counterparties', () => {
    it('повертає 200 з pagination shape', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 20 });
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/counterparties?page=1&limit=20',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        items: expect.any(Array),
        total: expect.any(Number),
        page: expect.any(Number),
        limit: expect.any(Number),
      });
    });

    it('приймає limit=200 без помилки 400 (для dropdown-списків)', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 200 });
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/counterparties?limit=200',
      });
      expect(res.statusCode).toBe(200);
    });

    it('відхиляє limit=201 з 400', async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/counterparties?limit=201',
      });
      expect(res.statusCode).toBe(400);
    });

    it('приймає ?types=SUPPLIER,BOTH (comma-separated) без 400', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 200 });
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/counterparties?types=SUPPLIER,BOTH&limit=200',
      });
      expect(res.statusCode).toBe(200);
    });

    it('приймає ?types=CLIENT&types=SUPPLIER (Fastify multi-value syntax)', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 20 });
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/counterparties?types=CLIENT&types=SUPPLIER',
      });
      expect(res.statusCode).toBe(200);
    });

    it('відхиляє ?types=INVALID_TYPE з 400', async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/counterparties?types=INVALID_TYPE',
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 403 без авторизації', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/counterparties',
      });
      jwtAllow = true;
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET :id/contracts', () => {
    it('повертає 200 зі списком договорів', async () => {
      serviceMock.findContracts.mockResolvedValueOnce([]);
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/counterparties/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/contracts',
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });
  });

  describe('POST :id/contracts', () => {
    it("повертає 400 без обов'язкового поля contractType", async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/counterparties/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/contracts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ startDate: '2026-01-01' }),
      });
      expect(res.statusCode).toBe(400);
    });

    it("повертає 400 без обов'язкового поля startDate", async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/counterparties/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/contracts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ contractType: 'PURCHASE' }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 201 при валідному body', async () => {
      jwtAllow = true;
      serviceMock.createContract.mockResolvedValueOnce({
        id: 'con-1',
        orgId: 'org-1',
        counterpartyId: 'cp-1',
        number: 'ДГ-1',
        contractType: 'PURCHASE',
        startDate: '2026-01-01',
        endDate: null,
        isPrimary: true,
        creditLimit: null,
        paymentDeferDays: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/counterparties/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/contracts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ contractType: 'PURCHASE', startDate: '2026-01-01' }),
      });
      expect(res.statusCode).toBe(201);
    });
  });

  describe('PATCH :id/contracts/:contractId', () => {
    it('повертає 200 при валідному body', async () => {
      jwtAllow = true;
      serviceMock.updateContract.mockResolvedValueOnce({
        id: 'con-1',
        orgId: 'org-1',
        counterpartyId: 'cp-1',
        number: 'ДГ-1',
        contractType: 'PURCHASE',
        startDate: '2026-01-01',
        endDate: null,
        isPrimary: true,
        creditLimit: null,
        paymentDeferDays: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: '/counterparties/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/contracts/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ isPrimary: true }),
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('DELETE :id/contracts/:contractId', () => {
    it('повертає 204', async () => {
      jwtAllow = true;
      serviceMock.removeContract.mockResolvedValueOnce(undefined);
      const res = await (app as NestFastifyApplication).inject({
        method: 'DELETE',
        url: '/counterparties/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/contracts/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      });
      expect(res.statusCode).toBe(204);
    });
  });

  describe('POST /counterparties', () => {
    it("повертає 400 без обов'язкового поля type", async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/counterparties',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ firstName: 'Іван' }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 при невалідному enum type', async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/counterparties',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'INVALID_TYPE' }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 201 при валідному body (type=CLIENT)', async () => {
      jwtAllow = true;
      serviceMock.create.mockResolvedValueOnce({
        id: 'cp-uuid',
        orgId: 'org-1',
        type: 'CLIENT',
        vatPayer: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/counterparties',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'CLIENT', firstName: 'Ivan', lastName: 'Petrenko' }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ id: expect.any(String), type: 'CLIENT' });
    });
  });
});
