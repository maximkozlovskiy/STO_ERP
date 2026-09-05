import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PdfService } from '../pdf/pdf.service';

// ─── Mocks ────────────────────────────────────────────────

const serviceMock = {
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  createFromWorkOrder: vi.fn(),
  refreshFromWorkOrder: vi.fn(),
  findByWorkOrder: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  transition: vi.fn(),
  clone: vi.fn(),
  generatePdf: vi.fn(),
  addLine: vi.fn(),
  updateLine: vi.fn(),
  removeLine: vi.fn(),
  getLinkedDocuments: vi.fn(),
  getLinkedCounts: vi.fn(),
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

// Bug #339: invoices module had no contract spec at all — dateFrom/dateTo forwarding was untested.
describe('Invoices — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [InvoicesController],
      providers: [
        { provide: InvoicesService, useValue: serviceMock },
        { provide: PrismaService, useValue: {} },
        { provide: DocumentNumberService, useValue: {} },
        { provide: PdfService, useValue: {} },
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

  describe('GET /invoices', () => {
    it('повертає 200 з pagination shape', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 20 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/invoices?page=1&limit=20',
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
      const res = await (app as NestFastifyApplication).inject({ method: 'GET', url: '/invoices' });
      expect(res.statusCode).toBe(403);
    });

    it('відхиляє limit=201 з 400', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/invoices?limit=201',
      });
      expect(res.statusCode).toBe(400);
    });

    // Bug #339 regression guard — dateFrom/dateTo мають прокидатись до service.findAll
    it('Bug #339: dateFrom + dateTo → service.findAll отримує дати', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 20 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/invoices?dateFrom=2026-01-01&dateTo=2026-01-31',
      });
      expect(res.statusCode).toBe(200);
      // Bug #340: controller.findAll прокидує 10 args у service.findAll
      // (orgId, page, limit, status, q, showDeleted, dateFrom, dateTo, sortBy, sortDir)
      // — sortBy/sortDir додано у 65db856 (column sorting feature).
      expect(serviceMock.findAll).toHaveBeenCalledWith(
        'org-1',
        1,
        20,
        undefined,
        undefined,
        false,
        '2026-01-01',
        '2026-01-31',
        undefined,
        undefined,
      );
    });

    it('Bug #339: showDeleted=true → service.findAll отримує true', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 20 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/invoices?showDeleted=true',
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
        undefined,
        undefined,
      );
    });

    it('Bug #339: status + q → service.findAll отримує фільтри', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 20 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/invoices?status=DRAFT&q=INV-001',
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.findAll).toHaveBeenCalledWith(
        'org-1',
        1,
        20,
        'DRAFT',
        'INV-001',
        false,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe('POST /invoices', () => {
    it("повертає 400 без обов'язкових полів (counterpartyId, amount)", async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/invoices',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ notes: 'test' }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 коли counterpartyId не UUID', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/invoices',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ counterpartyId: 'not-uuid', amount: 100 }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 коли amount = 0 (Min(0.01))', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/invoices',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ counterpartyId: VALID_UUID, amount: 0 }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 201 при валідному body', async () => {
      serviceMock.create.mockResolvedValueOnce({
        id: VALID_UUID,
        orgId: 'org-1',
        number: 'INV-2026-0001',
        status: 'DRAFT',
        counterpartyId: VALID_UUID,
        amount: 100,
        totalWithoutVat: 100,
        totalVat: 0,
        totalWithVat: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/invoices',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ counterpartyId: VALID_UUID, amount: 100 }),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: expect.any(String), number: expect.any(String) });
    });

    it('documentDate="" → передається undefined до service (emptyToUndefined transform)', async () => {
      serviceMock.create.mockResolvedValueOnce({
        id: VALID_UUID,
        orgId: 'org-1',
        number: 'INV-2026-0002',
        status: 'DRAFT',
        counterpartyId: VALID_UUID,
        amount: 50,
        totalWithoutVat: 50,
        totalVat: 0,
        totalWithVat: 50,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/invoices',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ counterpartyId: VALID_UUID, amount: 50, documentDate: '' }),
      });
      expect(res.statusCode).toBe(201);
      const dtoArg = serviceMock.create.mock.calls[0]![1] as Record<string, unknown>;
      expect(dtoArg.documentDate).toBeUndefined();
    });
  });

  describe('GET /invoices/:id', () => {
    it('повертає 200 при валідному UUID', async () => {
      serviceMock.findOne.mockResolvedValueOnce({
        id: VALID_UUID,
        orgId: 'org-1',
        number: 'INV-001',
        status: 'DRAFT',
        counterpartyId: VALID_UUID,
        amount: 100,
        totalWithoutVat: 100,
        totalVat: 0,
        totalWithVat: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lines: [],
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/invoices/${VALID_UUID}`,
      });
      expect(res.statusCode).toBe(200);
    });

    it('повертає 400 для не-UUID id', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/invoices/not-a-uuid',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // Bug #403/#405/#406: contract spec для нових ендпоінтів фічі "Виставити рахунок".
  describe('GET /invoices/from-work-order/:workOrderId/find', () => {
    it('повертає 200 з null коли рахунку немає (Bug #405 — не 404)', async () => {
      serviceMock.findByWorkOrder.mockResolvedValueOnce(null);
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/invoices/from-work-order/${VALID_UUID}/find`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toBeNull();
    });

    it('повертає 200 з { id, number, status, amount, documentDate } коли рахунок існує (Bug #509)', async () => {
      // Bug #509: контракт розширено у 523190f2 — wire shape тепер 5 полів для invoice
      // slot у картці наряду. Regression-guard: refactor що видалить status/amount/
      // documentDate з `select` clause service-у або з мапінгу → contract spec падає.
      serviceMock.findByWorkOrder.mockResolvedValueOnce({
        id: VALID_UUID,
        number: 'INV-2026-0001',
        status: 'DRAFT',
        amount: 200,
        documentDate: '2026-01-15T00:00:00.000Z',
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/invoices/from-work-order/${VALID_UUID}/find`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id: VALID_UUID,
        number: 'INV-2026-0001',
        status: 'DRAFT',
        amount: 200,
        documentDate: '2026-01-15T00:00:00.000Z',
      });
    });

    it('повертає documentDate=null коли інвойс без дати документа (Bug #509 null branch)', async () => {
      serviceMock.findByWorkOrder.mockResolvedValueOnce({
        id: VALID_UUID,
        number: 'INV-2026-0001',
        status: 'DRAFT',
        amount: 200,
        documentDate: null,
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/invoices/from-work-order/${VALID_UUID}/find`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id: VALID_UUID,
        number: 'INV-2026-0001',
        status: 'DRAFT',
        amount: 200,
        documentDate: null,
      });
    });

    it('повертає 400 для не-UUID workOrderId', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/invoices/from-work-order/not-uuid/find',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /invoices/from-work-order/:workOrderId/refresh', () => {
    it('повертає 200 + service.refreshFromWorkOrder викликаний', async () => {
      serviceMock.refreshFromWorkOrder.mockResolvedValueOnce({
        id: VALID_UUID,
        orgId: 'org-1',
        number: 'INV-2026-0001',
        status: 'DRAFT',
        counterpartyId: VALID_UUID,
        amount: 200,
        totalWithoutVat: 166.67,
        totalVat: 33.33,
        totalWithVat: 200,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: `/invoices/from-work-order/${VALID_UUID}/refresh`,
      });
      expect(res.statusCode).toBe(201);
      expect(serviceMock.refreshFromWorkOrder).toHaveBeenCalledWith('org-1', VALID_UUID);
    });

    it('повертає 400 для не-UUID workOrderId', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/invoices/from-work-order/not-uuid/refresh',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Linked documents (Phase B backend) ────────────────────
  describe('GET /invoices/:id/linked-documents', () => {
    it('повертає 200 і делегує (orgId, id)', async () => {
      serviceMock.getLinkedDocuments.mockResolvedValueOnce({
        workOrder: [],
        payments: [],
        counterparty: [],
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/invoices/${VALID_UUID}/linked-documents`,
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.getLinkedDocuments).toHaveBeenCalledWith('org-1', VALID_UUID);
    });

    it('повертає 400 для не-UUID id', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/invoices/not-uuid/linked-documents',
      });
      expect(res.statusCode).toBe(400);
    });

    // Route ordering: :id/linked-documents НЕ має бути перехоплений @Get(':id').
    it('route ordering: linked-documents не ловиться :id (findOne НЕ викликаний)', async () => {
      serviceMock.getLinkedDocuments.mockResolvedValueOnce({
        workOrder: [],
        payments: [],
        counterparty: [],
      });
      await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/invoices/${VALID_UUID}/linked-documents`,
      });
      expect(serviceMock.getLinkedDocuments).toHaveBeenCalledTimes(1);
      expect(serviceMock.findOne).not.toHaveBeenCalled();
    });
  });

  describe('POST /invoices/linked-counts', () => {
    it('повертає 200 і делегує (orgId, ids)', async () => {
      serviceMock.getLinkedCounts.mockResolvedValueOnce({});
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/invoices/linked-counts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ ids: [VALID_UUID] }),
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.getLinkedCounts).toHaveBeenCalledWith('org-1', [VALID_UUID]);
    });

    it('повертає 400 для порожнього масиву (ArrayMinSize)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/invoices/linked-counts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ ids: [] }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 для 501 id (ArrayMaxSize)', async () => {
      const ids = Array.from({ length: 501 }, () => VALID_UUID);
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/invoices/linked-counts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ ids }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 для non-UUID елемента', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/invoices/linked-counts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ ids: ['not-a-uuid'] }),
      });
      expect(res.statusCode).toBe(400);
    });

    // Route ordering: POST /linked-counts не має вимагати UUID :id.
    it('route ordering: linked-counts не ловиться POST :id', async () => {
      serviceMock.getLinkedCounts.mockResolvedValueOnce({});
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/invoices/linked-counts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ ids: [VALID_UUID] }),
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.getLinkedCounts).toHaveBeenCalledTimes(1);
    });
  });
});
