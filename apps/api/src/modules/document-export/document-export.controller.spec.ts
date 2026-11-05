/**
 * HTTP-контракт друку й «Зберегти як» (BR-INV-028, BR-PO-016, BR-SDOC-009, BR-SRET-014):
 * `GET /<документ>/:id/export/:format`. Справжній RolesGuard за `@Roles`, справжній
 * `DocumentExportService` і PdfService над Prisma-двійником, що виконує `where`.
 *
 * Мутація (2026-11-05): прибрати `parseExportFormat` з контролера → падає «невідомий формат — 400»
 * (сервіс із форматом `exe` віддав би DOCX).
 */
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { PdfService } from '../pdf/pdf.service';
import { OrgPrintInfoService } from '../pdf/org-print-info.service';
import { DocumentExportController } from './document-export.controller';
import { DocumentExportService } from './document-export.service';
import {
  INVOICE_ID,
  ORG,
  ORG_INFO,
  OTHER_ORG,
  PO_ID,
  SD_ID,
  SR_ID,
  printWorld,
  sampleStore,
} from './document-export.spec-fixture';

let jwt = { role: 'OWNER', orgId: ORG };
const world = printWorld(sampleStore());

const ROUTES = {
  invoice: `/invoices/${INVOICE_ID}/export`,
  purchaseOrder: `/purchase-orders/${PO_ID}/export`,
  stockDocument: `/stock-documents/${SD_ID}/export`,
  supplierReturn: `/supplier-returns/${SR_ID}/export`,
};

describe('DocumentExportController', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [DocumentExportController],
      providers: [
        DocumentExportService,
        PdfService,
        { provide: PrismaService, useValue: world.prisma },
        { provide: OrgPrintInfoService, useValue: { get: () => Promise.resolve(ORG_INFO) } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = { id: 'emp-1', ...jwt };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => new RolesGuard(new Reflector()).canActivate(ctx),
      })
      .compile();
    const nest: INestApplication = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await nest.init();
    app = nest as NestFastifyApplication;
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jwt = { role: 'OWNER', orgId: ORG };
    world.reads.length = 0;
  });

  // guards: BR-INV-028, BR-PO-016, BR-SDOC-009, BR-SRET-014
  it.each([
    ['invoice', 'ACCOUNTANT'],
    ['invoice', 'RECEPTIONIST'],
    ['purchaseOrder', 'STOREKEEPER'],
    ['purchaseOrder', 'ACCOUNTANT'],
    ['stockDocument', 'STOREKEEPER'],
    ['supplierReturn', 'STOREKEEPER'],
    ['supplierReturn', 'ACCOUNTANT'],
  ] as const)(
    '%s: роль %s, що читає документ, отримує файл',
    async (kind, role) => {
      jwt = { role, orgId: ORG };
      const res = await app.inject({ method: 'GET', url: `${ROUTES[kind]}/pdf` });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
    },
    20_000,
  );

  // guards: BR-INV-028, BR-PO-016, BR-SDOC-009, BR-SRET-014
  it.each([
    ['invoice', 'STOREKEEPER'],
    ['invoice', 'MECHANIC'],
    ['purchaseOrder', 'RECEPTIONIST'],
    ['stockDocument', 'RECEPTIONIST'],
    ['stockDocument', 'ACCOUNTANT'],
    ['supplierReturn', 'RECEPTIONIST'],
  ] as const)('%s: роль %s, що не читає документ, — 403 без запиту в базу', async (kind, role) => {
    jwt = { role, orgId: ORG };
    const res = await app.inject({ method: 'GET', url: `${ROUTES[kind]}/xlsx` });

    expect(res.statusCode).toBe(403);
    expect(world.reads).toHaveLength(0);
  });

  // guards: BR-INV-028, BR-PO-016, BR-SDOC-009, BR-SRET-014
  it.each(['exe', 'PDF', 'csv'])(
    'невідомий формат «%s» — 400 українською, документ не читається',
    async fmt => {
      const res = await app.inject({ method: 'GET', url: `${ROUTES.invoice}/${fmt}` });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toContain('Невідомий формат файлу');
      expect(res.json<{ message: string }>().message).toContain('pdf, xlsx, docx');
      expect(world.reads).toHaveLength(0);
    },
  );

  // guards: BR-INV-028, BR-PO-016, BR-SDOC-009, BR-SRET-014
  it.each(Object.keys(ROUTES) as (keyof typeof ROUTES)[])(
    '%s іншої організації — 404',
    async kind => {
      jwt = { role: 'OWNER', orgId: OTHER_ORG };
      const res = await app.inject({ method: 'GET', url: `${ROUTES[kind]}/docx` });

      expect(res.statusCode).toBe(404);
      expect(world.reads[0]).toMatchObject({ orgId: OTHER_ORG });
    },
  );

  // guards: BR-INV-028, BR-PO-016, BR-SDOC-009, BR-SRET-014
  it.each([
    ['invoice', 'xlsx', 'Рахунок-INV-2026-0001.xlsx'],
    ['purchaseOrder', 'docx', 'Замовлення-PO-0007.docx'],
    ['stockDocument', 'xlsx', 'Переміщення-SD-0003.xlsx'],
    ['supplierReturn', 'docx', 'Повернення-SR-0002.docx'],
  ] as const)("%s.%s — ім'я файла кирилицею у filename*=UTF-8''", async (kind, fmt, name) => {
    const res = await app.inject({ method: 'GET', url: `${ROUTES[kind]}/${fmt}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    expect(Number(res.headers['content-length'])).toBe(res.rawPayload.length);
  });

  it('id не UUID — 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/invoices/abc/export/pdf' });
    expect(res.statusCode).toBe(400);
  });
});
