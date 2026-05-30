import { Controller, Get, Post, Param, ParseUUIDPipe, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, ApiConsumes } from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';
import { MultipartFile } from '@fastify/multipart';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { Request } from '@nestjs/common';
import { XlsxService, ImportResult } from './xlsx.service';
import { GoodsService } from '../goods/goods.service';
import { BrandsService } from '../brands/brands.service';
import { UnitsService } from '../units/units.service';
import { WorksService } from '../works/works.service';

@ApiTags('XLSX Import')
@Controller('xlsx')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class XlsxController {
  constructor(
    private readonly xlsxService: XlsxService,
    private readonly goodsService: GoodsService,
    private readonly brandsService: BrandsService,
    private readonly unitsService: UnitsService,
    private readonly worksService: WorksService,
  ) {}

  // ─── Templates ───────────────────────────────────────────────────────────────

  @Get('templates/:type')
  @Roles('OWNER', 'ADMIN', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'Завантажити шаблон для імпорту' })
  async getTemplate(@Param('type') type: string) {
    let buffer: Buffer;
    let filename: string;

    switch (type) {
      case 'goods':
        buffer = await this.xlsxService.generateGoodsTemplate();
        filename = 'goods_template.xlsx';
        break;
      case 'works':
        buffer = await this.xlsxService.generateWorksTemplate();
        filename = 'works_template.xlsx';
        break;
      case 'brands':
        buffer = await this.xlsxService.generateBrandsTemplate();
        filename = 'brands_template.xlsx';
        break;
      case 'units':
        buffer = await this.xlsxService.generateUnitsTemplate();
        filename = 'units_template.xlsx';
        break;
      case 'po-lines':
        buffer = await this.xlsxService.generatePOLinesTemplate();
        filename = 'po_lines_template.xlsx';
        break;
      case 'sd-lines':
        buffer = await this.xlsxService.generateSDLinesTemplate();
        filename = 'sd_lines_template.xlsx';
        break;
      case 'wo-parts':
        buffer = await this.xlsxService.generateWOPartsTemplate();
        filename = 'wo_parts_template.xlsx';
        break;
      case 'pricing-list':
        buffer = this.xlsxService.generatePricingListTemplate();
        filename = 'pricing-list-template.csv';
        break;
      default:
        throw new BadRequestException('Невідомий тип шаблону');
    }

    return {
      file: buffer.toString('base64'),
      filename,
    };
  }

  // ─── Catalog Imports ──────────────────────────────────────────────────────────

  @Post('import/goods')
  @Roles('OWNER', 'ADMIN', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'Імпортувати товари з XLSX' })
  @ApiConsumes('multipart/form-data')
  async importGoods(
    @OrgContext() orgId: string,
    @Request() req: FastifyRequest,
  ): Promise<ImportResult> {
    const file = await this.getUploadedFile(req);
    const buffer = await file.toBuffer();
    const rows = await this.xlsxService.parseGoods(buffer);

    const result: ImportResult = { created: 0, updated: 0, errors: [] };

    for (const row of rows) {
      try {
        if (row.sku) {
          // Check if exists
          const existing = (await this.goodsService.findAll(orgId, { page: 1, limit: 10, q: row.sku })).items.find(g => g.sku === row.sku);
          if (existing) {
            result.updated++;
            continue;
          }
        }
        if (row.salePrice) {
          await this.goodsService.create(orgId, {
            sku: row.sku,
            name: row.name,
            unit: row.unit ?? 'шт',
            purchasePrice: row.purchasePrice,
            salePrice: row.salePrice,
            category: row.category,
          });
        }
        result.created++;
      } catch (e: unknown) {
        result.errors.push(`${row.name}: ${e instanceof Error ? e.message : 'помилка'}`);
      }
    }

    return result;
  }

  @Post('import/brands')
  @Roles('OWNER', 'ADMIN', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'Імпортувати бренди з XLSX' })
  async importBrands(
    @OrgContext() orgId: string,
    @Request() req: FastifyRequest,
  ): Promise<ImportResult> {
    const file = await this.getUploadedFile(req);
    const buffer = await file.toBuffer();
    const rows = await this.xlsxService.parseBrands(buffer);

    const result: ImportResult = { created: 0, updated: 0, errors: [] };

    for (const row of rows) {
      try {
        await this.brandsService.create(orgId, { name: row.name });
        result.created++;
      } catch (e: unknown) {
        // Assume conflict = already exists
        if (e instanceof Error && e.message.includes('уже')) {
          result.updated++;
        } else {
          result.errors.push(`${row.name}: ${e instanceof Error ? e.message : 'помилка'}`);
        }
      }
    }

    return result;
  }

  @Post('import/units')
  @Roles('OWNER', 'ADMIN', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'Імпортувати одиниці виміру з XLSX' })
  async importUnits(
    @OrgContext() orgId: string,
    @Request() req: FastifyRequest,
  ): Promise<ImportResult> {
    const file = await this.getUploadedFile(req);
    const buffer = await file.toBuffer();
    const rows = await this.xlsxService.parseUnits(buffer);

    const result: ImportResult = { created: 0, updated: 0, errors: [] };

    for (const row of rows) {
      try {
        await this.unitsService.create(orgId, { name: row.name, shortName: row.shortName });
        result.created++;
      } catch (e: unknown) {
        if (e instanceof Error && e.message.includes('уже')) {
          result.updated++;
        } else {
          result.errors.push(`${row.name}: ${e instanceof Error ? e.message : 'помилка'}`);
        }
      }
    }

    return result;
  }

  @Post('import/works')
  @Roles('OWNER', 'ADMIN', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'Імпортувати роботи з XLSX' })
  @ApiConsumes('multipart/form-data')
  async importWorks(
    @OrgContext() orgId: string,
    @Request() req: FastifyRequest,
  ): Promise<ImportResult> {
    const file = await this.getUploadedFile(req);
    const buffer = await file.toBuffer();
    const rows = await this.xlsxService.parseWorks(buffer);

    const result: ImportResult = { created: 0, updated: 0, errors: [] };

    for (const row of rows) {
      try {
        const category = await this.worksService.findCategoryByName(orgId, row.categoryName);
        if (!category) {
          result.errors.push(`${row.name}: категорія "${row.categoryName}" не знайдена`);
          continue;
        }
        await this.worksService.create(orgId, {
          categoryId: category.id,
          name: row.name,
          normoHours: row.normoHours,
          price: row.price,
          description: row.description,
        });
        result.created++;
      } catch (e: unknown) {
        result.errors.push(`${row.name}: ${e instanceof Error ? e.message : 'помилка'}`);
      }
    }

    return result;
  }

  // ─── Document line imports ────────────────────────────────────────────────────

  @Post('import/purchase-order-lines/:poId')
  @Roles('OWNER', 'ADMIN', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'Імпортувати позиції замовлення постачальника з XLSX' })
  @ApiConsumes('multipart/form-data')
  async importPOLines(
    @OrgContext() orgId: string,
    @Param('poId', ParseUUIDPipe) poId: string,
    @Request() req: FastifyRequest,
  ): Promise<ImportResult> {
    const file = await this.getUploadedFile(req);
    const buffer = await file.toBuffer();
    return this.xlsxService.importPOLines(orgId, poId, buffer);
  }

  @Post('import/stock-document-lines/:docId')
  @Roles('OWNER', 'ADMIN', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'Імпортувати позиції складського документа з XLSX' })
  @ApiConsumes('multipart/form-data')
  async importSDLines(
    @OrgContext() orgId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @Request() req: FastifyRequest,
  ): Promise<ImportResult> {
    const file = await this.getUploadedFile(req);
    const buffer = await file.toBuffer();
    return this.xlsxService.importSDLines(orgId, docId, buffer);
  }

  @Post('import/work-order-parts/:woId')
  @Roles('OWNER', 'ADMIN', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'Імпортувати запчастини наряду з XLSX' })
  @ApiConsumes('multipart/form-data')
  async importWOParts(
    @OrgContext() orgId: string,
    @Param('woId', ParseUUIDPipe) woId: string,
    @Request() req: FastifyRequest,
  ): Promise<ImportResult> {
    const file = await this.getUploadedFile(req);
    const buffer = await file.toBuffer();
    return this.xlsxService.importWOParts(orgId, woId, buffer);
  }

  // ─── Pricing from list ────────────────────────────────────────────────────────

  @Post('apply-pricing-from-list')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'Розцінити товари за списком XLSX/CSV' })
  @ApiConsumes('multipart/form-data')
  async applyPricingFromList(
    @OrgContext() orgId: string,
    @Request() req: FastifyRequest,
  ) {
    const file = await this.getUploadedFile(req);
    const buffer = await file.toBuffer();
    const fileType: 'xlsx' | 'csv' = (file.filename ?? '').toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx';
    return this.xlsxService.applyPricingFromList(orgId, buffer, fileType);
  }

  // ─── Helper ───────────────────────────────────────────────────────────────────

  private async getUploadedFile(req: FastifyRequest): Promise<MultipartFile> {
    const data = await req.file();
    if (!data) throw new BadRequestException('Файл не завантажено');
    return data;
  }
}
