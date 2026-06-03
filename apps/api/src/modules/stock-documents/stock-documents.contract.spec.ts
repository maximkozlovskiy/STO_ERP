import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { StockDocumentsController } from './stock-documents.controller';
import { StockDocumentsService } from './stock-documents.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { DocumentNumberService } from '../document-number/document-number.service';

// ─── Mocks ────────────────────────────────────────────────

const serviceMock = {
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  transition: vi.fn(),
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

// Bug #339: stock-documents module had no contract spec at all — dateFrom/dateTo forwarding was untested.
describe('StockDocuments — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [StockDocumentsController],
      providers: [
        { provide: StockDocumentsService, useValue: serviceMock },
        { provide: PrismaService, useValue: {} },
        { provide: InventoryService, useValue: {} },
        { provide: DocumentNumberService, useValue: {} },
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

  beforeEach(() => {
    jwtAllow = true;
    vi.clearAllMocks();
  });

  const VALID_UUID = '11111111-1111-4111-8111-111111111111';

  describe('GET /stock-documents', () => {
    it('повертає 200 з pagination shape', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 20 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-documents?page=1&limit=20',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        items: expect.any(Array),
        total: expect.any(Number),
        page: expect.any(Number),
        limit: expect.any(Number),
      });
    });

    it('повертає 403 без JWT', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-documents',
      });
      expect(res.statusCode).toBe(403);
    });

    it('відхиляє limit=201 з 400', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-documents?limit=201',
      });
      expect(res.statusCode).toBe(400);
    });

    // Bug #339 regression guard — dateFrom/dateTo мають прокидатись до service.findAll
    it('Bug #339: dateFrom + dateTo → service.findAll отримує дати', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 20 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-documents?dateFrom=2026-01-01&dateTo=2026-01-31',
      });
      expect(res.statusCode).toBe(200);
      // StockDocumentsController.findAll викликає service.findAll(orgId, page, limit, type, status, showDeleted, dateFrom, dateTo)
      expect(serviceMock.findAll).toHaveBeenCalledWith(
        'org-1',
        1,
        20,
        undefined,
        undefined,
        false,
        '2026-01-01',
        '2026-01-31',
      );
    });

    it('Bug #339: showDeleted=true → service.findAll отримує true', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 20 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-documents?showDeleted=true',
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.findAll).toHaveBeenCalledWith(
        'org-1',
        1,
        20,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
      );
    });

    it('Bug #339: type + status → service.findAll отримує фільтри', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 20 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-documents?type=WRITEOFF&status=DRAFT',
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.findAll).toHaveBeenCalledWith(
        'org-1',
        1,
        20,
        'WRITEOFF',
        'DRAFT',
        false,
        undefined,
        undefined,
      );
    });

    it('відхиляє невалідний type з 400', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-documents?type=INVALID_TYPE',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /stock-documents', () => {
    it("повертає 400 без обов'язкових полів (type, branchId, warehouseId)", async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/stock-documents',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ notes: 'test' }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 при невалідному type', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/stock-documents',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'INVALID', branchId: VALID_UUID, warehouseId: VALID_UUID }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 201 при валідному body', async () => {
      serviceMock.create.mockResolvedValueOnce({
        id: VALID_UUID,
        orgId: 'org-1',
        number: 'SD-2026-0001',
        type: 'WRITEOFF',
        status: 'DRAFT',
        branchId: VALID_UUID,
        warehouseId: VALID_UUID,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lines: [],
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/stock-documents',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          type: 'WRITEOFF',
          branchId: VALID_UUID,
          warehouseId: VALID_UUID,
        }),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: expect.any(String), type: 'WRITEOFF' });
    });

    it('documentDate="" → передається undefined до service (emptyToUndefined transform)', async () => {
      serviceMock.create.mockResolvedValueOnce({
        id: VALID_UUID,
        orgId: 'org-1',
        number: 'SD-2026-0002',
        type: 'WRITEOFF',
        status: 'DRAFT',
        branchId: VALID_UUID,
        warehouseId: VALID_UUID,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lines: [],
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/stock-documents',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          type: 'WRITEOFF',
          branchId: VALID_UUID,
          warehouseId: VALID_UUID,
          documentDate: '',
        }),
      });
      expect(res.statusCode).toBe(201);
      const dtoArg = serviceMock.create.mock.calls[0]![1] as Record<string, unknown>;
      expect(dtoArg.documentDate).toBeUndefined();
    });
  });

  describe('GET /stock-documents/:id', () => {
    it('повертає 400 для не-UUID id', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-documents/not-a-uuid',
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
