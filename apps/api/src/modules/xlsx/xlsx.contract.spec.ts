import type { INestApplication } from '@nestjs/common';
import { ConflictException, ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
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
  parseBrands: vi.fn(),
  parseGoods: vi.fn(),
  findExistingGoodRows: vi.fn(),
  resolvePricingRuleGoods: vi.fn(),
  generatePricingRuleGoodsTemplate: vi.fn(),
};

const goodsServiceMock = { findAll: vi.fn(), create: vi.fn() };
const brandsServiceMock = { create: vi.fn() };
const unitsServiceMock = { create: vi.fn() };
const worksServiceMock = { create: vi.fn(), findCategoryByName: vi.fn() };

let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
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
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );

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
      xlsxServiceMock.generatePricingListTemplate.mockReturnValueOnce(
        Buffer.from('sku,barcode,name\n', 'utf-8'),
      );
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

  // guards: BR-GOOD-007
  describe('POST /xlsx/import/brands', () => {
    const BOUNDARY = 'reviewbrboundary';
    const upload = () =>
      (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/xlsx/import/brands',
        headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
        payload:
          `--${BOUNDARY}\r\n` +
          'Content-Disposition: form-data; name="file"; filename="brands.xlsx"\r\n' +
          'Content-Type: application/octet-stream\r\n\r\n' +
          // BR-SEC-UPLOAD: валідна zip-сигнатура — контролер звіряє магічні байти .xlsx до розбору.
          'PK\x03\x04payload\r\n' +
          `--${BOUNDARY}--\r\n`,
      });

    // Масовий імпорт не падає цілим файлом на 409: рядок, якому відмовило правило, пропускається
    // з поясненням, решта імпортується. Раніше наявний бренд («…вже існує») ішов у помилки, а
    // відмова правила («…уже є синонімом…») рахувалась як «оновлено» — розпізнавання було за
    // словом «уже» в тексті.
    it('наявний бренд — пропуск без помилки; відмова BR-GOOD-007 — рядок у errors; решта створюється', async () => {
      xlsxServiceMock.parseBrands.mockResolvedValueOnce([
        { name: 'Новий' },
        { name: 'Bosch' },
        { name: 'БОШ' },
      ]);
      brandsServiceMock.create
        .mockResolvedValueOnce({ id: 'b-new' })
        .mockRejectedValueOnce(new ConflictException('Бренд з такою назвою вже існує'))
        .mockRejectedValueOnce(new ConflictException('Назва «БОШ» уже є синонімом бренду «Bosch»'));

      const res = await upload();

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        created: 1,
        updated: 0,
        skipped: 1,
        errors: ['БОШ: Назва «БОШ» уже є синонімом бренду «Bosch»'],
      });
      expect(brandsServiceMock.create).toHaveBeenCalledTimes(3);
    });
  });

  // guards: BR-GOOD-008
  describe('POST /xlsx/import/goods', () => {
    const BOUNDARY = 'goodsimportboundary';
    const upload = () =>
      (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/xlsx/import/goods',
        headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
        payload:
          `--${BOUNDARY}\r\n` +
          'Content-Disposition: form-data; name="file"; filename="goods.xlsx"\r\n' +
          'Content-Type: application/octet-stream\r\n\r\n' +
          // BR-SEC-UPLOAD: валідна zip-сигнатура — контролер звіряє магічні байти .xlsx до розбору.
          'PK\x03\x04payload\r\n' +
          `--${BOUNDARY}--\r\n`,
      });

    // Mutation-verify: прибрати `exists[i]` → наявний товар створюється вдруге; прибрати
    // `seenArticles` → той самий артикул двічі у файлі створює два товари.
    it('наявний товар і повтор артикула у файлі не створюють дубль; пошук — один на файл', async () => {
      xlsxServiceMock.parseGoods.mockResolvedValueOnce([
        { sku: '04E-129-620', name: 'Є в каталозі', salePrice: 10 },
        { sku: 'NEW-1', name: 'Новий', salePrice: 20 },
        { sku: 'new 1', name: 'Той самий артикул, інше написання', salePrice: 20 },
        { name: 'Без артикула', salePrice: 30 },
      ]);
      xlsxServiceMock.findExistingGoodRows.mockResolvedValueOnce([true, false, false, false]);
      goodsServiceMock.create.mockResolvedValue({ id: 'g' });

      const res = await upload();

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ created: 2, updated: 0, skipped: 2, errors: [] });
      expect(xlsxServiceMock.findExistingGoodRows).toHaveBeenCalledTimes(1);
      expect(goodsServiceMock.create.mock.calls.map(c => (c[1] as { name: string }).name)).toEqual([
        'Новий',
        'Без артикула',
      ]);
      // Запиту на кожен рядок (N+1) більше немає.
      expect(goodsServiceMock.findAll).not.toHaveBeenCalled();
    });
  });

  // guards: BR-GOOD-009
  describe('перелік товарів для правила ціноутворення', () => {
    it('GET /xlsx/templates/pricing-rule-goods → 200 + { file, filename: .xlsx }', async () => {
      xlsxServiceMock.generatePricingRuleGoodsTemplate.mockResolvedValueOnce(Buffer.from('xlsx'));
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/xlsx/templates/pricing-rule-goods',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        file: Buffer.from('xlsx').toString('base64'),
        filename: 'pricing_rule_goods_template.xlsx',
      });
    });

    it('POST /xlsx/pricing-rule-goods/resolve без файла → 400, розбір не запускається', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/xlsx/pricing-rule-goods/resolve',
      });
      expect(res.statusCode).toBe(400);
      expect(xlsxServiceMock.resolvePricingRuleGoods).not.toHaveBeenCalled();
    });

    it('POST /xlsx/pricing-rule-goods/resolve: тип файла — за розширенням (.csv / решта xlsx)', async () => {
      const BOUNDARY = 'rulegoodsboundary';
      xlsxServiceMock.resolvePricingRuleGoods.mockResolvedValueOnce({
        total: 0,
        matched: [],
        ambiguous: [],
        notFound: [],
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/xlsx/pricing-rule-goods/resolve',
        headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
        payload:
          `--${BOUNDARY}\r\n` +
          'Content-Disposition: form-data; name="file"; filename="Список.CSV"\r\n' +
          'Content-Type: text/csv\r\n\r\n' +
          'sku\r\n' +
          `--${BOUNDARY}--\r\n`,
      });
      expect(res.statusCode).toBe(201);
      expect(xlsxServiceMock.resolvePricingRuleGoods).toHaveBeenCalledWith(
        'org-1',
        expect.any(Buffer),
        'csv',
      );
    });
  });
});
