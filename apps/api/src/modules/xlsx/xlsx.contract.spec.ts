import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import multipart from '@fastify/multipart';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { XlsxController } from './xlsx.controller';
import { XlsxService } from './xlsx.service';
import { GoodsService } from '../goods/goods.service';
import { BrandsService } from '../brands/brands.service';
import { UnitsService } from '../units/units.service';
import { WorksService } from '../works/works.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

// Bug #190: regression-захист для нових endpoints (templates/pricing-list + apply-pricing-from-list)
const xlsxServiceMock = {
  generatePricingListTemplate: vi.fn(),
  generateGoodsTemplate: vi.fn(),
  generateWorksTemplate: vi.fn(),
  generateBrandsTemplate: vi.fn(),
  generateUnitsTemplate: vi.fn(),
  generatePOLinesTemplate: vi.fn(),
  generateSDLinesTemplate: vi.fn(),
  generateWOPartsTemplate: vi.fn(),
  applyPricingFromList: vi.fn(),
};

const goodsServiceMock = { findAll: vi.fn(), create: vi.fn() };
const brandsServiceMock = { create: vi.fn() };
const unitsServiceMock = { create: vi.fn() };
const worksServiceMock = { create: vi.fn(), findCategoryByName: vi.fn() };

let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx) => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { id: 'emp-1', orgId: 'org-1', role: 'OWNER' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

describe('Xlsx — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [XlsxController],
      providers: [
        { provide: XlsxService, useValue: xlsxServiceMock },
        { provide: GoodsService, useValue: goodsServiceMock },
        { provide: BrandsService, useValue: brandsServiceMock },
        { provide: UnitsService, useValue: unitsServiceMock },
        { provide: WorksService, useValue: worksServiceMock },
      ],
    })
      .overrideGuard(JwtAuthGuard).useValue(mockJwtGuard)
      .overrideGuard(RolesGuard).useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));

    // Реєструємо multipart щоб req.file() працював
    const fastify = (app as NestFastifyApplication).getHttpAdapter().getInstance();
    await fastify.register(multipart);

    await app.init();
    await fastify.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jwtAllow = true;
    vi.clearAllMocks();
  });

  describe('GET /xlsx/templates/pricing-list', () => {
    it('Bug #190: 200 + { file, filename: .csv } для pricing-list типу', async () => {
      xlsxServiceMock.generatePricingListTemplate.mockReturnValueOnce(Buffer.from('sku,barcode,name\n', 'utf-8'));
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/xlsx/templates/pricing-list',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        file: expect.any(String),
        filename: 'pricing-list-template.csv',
      });
      expect(xlsxServiceMock.generatePricingListTemplate).toHaveBeenCalled();
    });

    it('Bug #190: 400 для невідомого типу', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/xlsx/templates/unknown-type',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/Невідомий тип/);
    });

    it('Bug #190: 403 без JWT', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/xlsx/templates/pricing-list',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /xlsx/apply-pricing-from-list', () => {
    it('Bug #190: 400 коли файл не завантажено', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/xlsx/apply-pricing-from-list',
        // no body / no multipart file
      });
      expect(res.statusCode).toBe(400);
      expect(xlsxServiceMock.applyPricingFromList).not.toHaveBeenCalled();
    });
  });
});
