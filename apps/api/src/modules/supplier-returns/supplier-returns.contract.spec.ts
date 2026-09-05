import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SupplierReturnsController } from './supplier-returns.controller';
import { SupplierReturnsService } from './supplier-returns.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DocumentNumberService } from '../document-number/document-number.service';

// ─── Mocks ────────────────────────────────────────────────

const serviceMock = {
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
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

// supplier-returns module had no contract spec at all (Phase D3) — route ordering
// (linked-documents / linked-counts vs :id) was untested. Mirrors invoices.contract.spec.ts.
describe('SupplierReturns — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SupplierReturnsController],
      providers: [
        { provide: SupplierReturnsService, useValue: serviceMock },
        { provide: PrismaService, useValue: {} },
        { provide: InventoryService, useValue: {} },
        { provide: SettlementsService, useValue: {} },
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

  describe('GET /supplier-returns', () => {
    it('повертає 200 з pagination shape', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 20 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/supplier-returns?page=1&limit=20',
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
        url: '/supplier-returns',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /supplier-returns', () => {
    it("повертає 400 без обов'язкових полів (supplierId, warehouseId)", async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/supplier-returns',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ notes: 'test' }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 201 при валідному body', async () => {
      serviceMock.create.mockResolvedValueOnce({
        id: VALID_UUID,
        orgId: 'org-1',
        number: 'ПВП-2026-0001',
        status: 'DRAFT',
        supplierId: VALID_UUID,
        warehouseId: VALID_UUID,
        totalAmount: 0,
        linesCount: 0,
        lines: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/supplier-returns',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ supplierId: VALID_UUID, warehouseId: VALID_UUID }),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: expect.any(String) });
    });
  });

  describe('GET /supplier-returns/:id', () => {
    it('повертає 400 для не-UUID id', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/supplier-returns/not-a-uuid',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Linked documents (Phase D3 backend) ────────────────────
  describe('GET /supplier-returns/:id/linked-documents', () => {
    it('повертає 200 і делегує (orgId, id)', async () => {
      serviceMock.getLinkedDocuments.mockResolvedValueOnce({
        purchaseOrder: [],
        counterparty: [],
        warehouse: [],
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/supplier-returns/${VALID_UUID}/linked-documents`,
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.getLinkedDocuments).toHaveBeenCalledWith('org-1', VALID_UUID);
    });

    it('повертає 400 для не-UUID id', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/supplier-returns/not-uuid/linked-documents',
      });
      expect(res.statusCode).toBe(400);
    });

    // Route ordering: :id/linked-documents НЕ має бути перехоплений @Get(':id').
    it('route ordering: linked-documents не ловиться :id (findOne НЕ викликаний)', async () => {
      serviceMock.getLinkedDocuments.mockResolvedValueOnce({
        purchaseOrder: [],
        counterparty: [],
        warehouse: [],
      });
      await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/supplier-returns/${VALID_UUID}/linked-documents`,
      });
      expect(serviceMock.getLinkedDocuments).toHaveBeenCalledTimes(1);
      expect(serviceMock.findOne).not.toHaveBeenCalled();
    });
  });

  describe('POST /supplier-returns/linked-counts', () => {
    it('повертає 200 і делегує (orgId, ids)', async () => {
      serviceMock.getLinkedCounts.mockResolvedValueOnce({});
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/supplier-returns/linked-counts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ ids: [VALID_UUID] }),
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.getLinkedCounts).toHaveBeenCalledWith('org-1', [VALID_UUID]);
    });

    it('повертає 400 для порожнього масиву (ArrayMinSize)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/supplier-returns/linked-counts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ ids: [] }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 для 501 id (ArrayMaxSize)', async () => {
      const ids = Array.from({ length: 501 }, () => VALID_UUID);
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/supplier-returns/linked-counts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ ids }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 для non-UUID елемента', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/supplier-returns/linked-counts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ ids: ['not-a-uuid'] }),
      });
      expect(res.statusCode).toBe(400);
    });

    // Route ordering: POST /linked-counts не має вимагати UUID :id і не колідує з :id/confirm.
    it('route ordering: linked-counts не ловиться POST :id/confirm', async () => {
      serviceMock.getLinkedCounts.mockResolvedValueOnce({});
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/supplier-returns/linked-counts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ ids: [VALID_UUID] }),
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.getLinkedCounts).toHaveBeenCalledTimes(1);
      expect(serviceMock.confirm).not.toHaveBeenCalled();
    });
  });
});
