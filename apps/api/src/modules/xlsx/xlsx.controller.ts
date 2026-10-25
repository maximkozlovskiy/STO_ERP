import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  ParseUUIDPipe,
  UseGuards,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiConsumes,
  ApiCreatedResponse,
} from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';
import { MultipartFile } from '@fastify/multipart';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { Request } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { normalizeArticle } from '../../common/utils/normalize-article';
import { err } from '../../common/utils/err';
import {
  assertImportFile,
  multipartFields,
  type ImportFileKind,
} from '../../common/utils/import-file-guard';
import { XlsxService, ImportResult, type ImportMapping } from './xlsx.service';
import type { ImportDocType } from './document-line-import.adapter';
import { ApplyImportDto, ResolveGoodsFileResponseDto } from './import.dto';
import { GoodsService } from '../goods/goods.service';
import { BrandsService } from '../brands/brands.service';
import { UnitsService } from '../units/units.service';
import { WorksService } from '../works/works.service';

const IMPORT_DOC_TYPES: readonly ImportDocType[] = ['PURCHASE_ORDER', 'STOCK_DOCUMENT'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Текст помилки рядка імпорту: повідомлення відмови або «невідома помилка» мовою запиту. */
function rowErrorText(e: unknown): string {
  return e instanceof Error ? e.message : err('err.xlsx.rowErrorUnknown');
}

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
      case 'pricing-rule-goods':
        buffer = await this.xlsxService.generatePricingRuleGoodsTemplate();
        filename = 'pricing_rule_goods_template.xlsx';
        break;
      case 'pricing-list':
        buffer = this.xlsxService.generatePricingListTemplate();
        filename = 'pricing-list-template.csv';
        break;
      default:
        throw new BadRequestException(translateError('err.xlsx.unknownTemplateType', getLocale()));
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
    const { buffer } = await this.readImportFile(req, 'xlsx');
    const rows = await this.xlsxService.parseGoods(buffer);

    const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };

    // Один пакетний пошук на файл замість запиту на рядок; артикул порівнюється нормалізовано.
    const exists = await this.xlsxService.findExistingGoodRows(orgId, rows);
    const seenArticles = new Set<string>();
    for (const [i, row] of rows.entries()) {
      try {
        const article = normalizeArticle(row.sku);
        // Наявний у каталозі або вже створений із цього ж файла — пропускаємо, дубль не робимо.
        // Це «пропущено», а не «оновлено»: наявний товар файл не змінює.
        if (article && (exists[i] || seenArticles.has(article))) {
          result.skipped = (result.skipped ?? 0) + 1;
          continue;
        }
        // Без ціни продажу товар не створюється — і це помилка рядка, а не «створено»
        // (раніше рядок рахувався створеним, хоча в каталог не потрапляв).
        if (!row.salePrice) {
          result.errors.push(`${row.name}: ${err('err.xlsx.goodNoSalePrice')}`);
          continue;
        }
        if (article) seenArticles.add(article);
        await this.goodsService.create(orgId, {
          sku: row.sku,
          name: row.name,
          unit: row.unit ?? 'шт',
          purchasePrice: row.purchasePrice,
          salePrice: row.salePrice,
          category: row.category,
        });
        result.created++;
      } catch (e: unknown) {
        result.errors.push(`${row.name}: ${rowErrorText(e)}`);
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
    const { buffer } = await this.readImportFile(req, 'xlsx');
    const rows = await this.xlsxService.parseBrands(buffer);

    const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };

    for (const row of rows) {
      try {
        await this.brandsService.create(orgId, { name: row.name });
        result.created++;
      } catch (e: unknown) {
        // Бренд із такою назвою вже є — рядок пропущено без помилки. Раніше це впізнавалось за
        // словом «уже» в тексті: «…вже існує» його не містить, тож наявні бренди йшли в помилки,
        // а відмова BR-GOOD-007 («Назва … уже є синонімом бренду …») рахувалась як «оновлено».
        // Тепер відмова правила — рядок у `errors` із назвою й поясненням; решта файла імпортується.
        const message = rowErrorText(e);
        const alreadyExists =
          e instanceof ConflictException && message === err('err.brand.nameExists');
        if (alreadyExists) result.skipped = (result.skipped ?? 0) + 1;
        else result.errors.push(`${row.name}: ${message}`);
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
    const { buffer } = await this.readImportFile(req, 'xlsx');
    const rows = await this.xlsxService.parseUnits(buffer);

    const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };

    // Одиниця з таким скороченням уже є — рядок пропущено. Впізнаємо за типом і ключем відмови, а
    // не за словом «уже» в тексті (англійською й інші відмови з «уже» давали хибний результат).
    const exists = new Set([
      err('err.unit.shortNameExists'),
      err('err.unit.activeShortNameExists'),
    ]);
    for (const row of rows) {
      try {
        await this.unitsService.create(orgId, { name: row.name, shortName: row.shortName });
        result.created++;
      } catch (e: unknown) {
        const message = rowErrorText(e);
        if (e instanceof ConflictException && exists.has(message)) {
          result.skipped = (result.skipped ?? 0) + 1;
        } else {
          result.errors.push(`${row.name}: ${message}`);
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
    const { buffer } = await this.readImportFile(req, 'xlsx');
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
        result.errors.push(`${row.name}: ${rowErrorText(e)}`);
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
    const { buffer } = await this.readImportFile(req, 'xlsx');
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
    const { buffer } = await this.readImportFile(req, 'xlsx');
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
    const { buffer } = await this.readImportFile(req, 'xlsx');
    return this.xlsxService.importWOParts(orgId, woId, buffer);
  }

  // ─── Pricing from list ────────────────────────────────────────────────────────

  @Post('apply-pricing-from-list')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'Розцінити товари за списком XLSX/CSV' })
  @ApiConsumes('multipart/form-data')
  async applyPricingFromList(@OrgContext() orgId: string, @Request() req: FastifyRequest) {
    const { buffer, filename } = await this.readImportFile(req, 'sheet');
    const fileType: 'xlsx' | 'csv' = filename.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx';
    return this.xlsxService.applyPricingFromList(orgId, buffer, fileType);
  }

  @Post('pricing-rule-goods/resolve')
  @Roles('OWNER', 'ADMIN', 'XLSX_MANAGER')
  @ApiOperation({
    summary: 'Розпізнати товари з файла для списку правила ціноутворення (нічого не пише)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiCreatedResponse({ type: ResolveGoodsFileResponseDto })
  async resolvePricingRuleGoods(
    @OrgContext() orgId: string,
    @Request() req: FastifyRequest,
  ): Promise<ResolveGoodsFileResponseDto> {
    const { buffer, filename } = await this.readImportFile(req, 'sheet');
    const fileType: 'xlsx' | 'csv' = filename.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx';
    return this.xlsxService.resolvePricingRuleGoods(orgId, buffer, fileType);
  }

  // ─── Generic document import (preview + apply) ──────────────────────────────────

  @Post('import/preview')
  @Roles('OWNER', 'ADMIN', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'Прев’ю generic-імпорту товарів у документ (PO/склад)' })
  @ApiConsumes('multipart/form-data')
  async previewImport(@OrgContext() orgId: string, @Request() req: FastifyRequest) {
    const { buffer, filename, file } = await this.readImportFile(req, 'document');
    const { num, str } = multipartFields(file);

    const docType = str('docType') as ImportDocType;
    if (!IMPORT_DOC_TYPES.includes(docType)) {
      throw new BadRequestException(translateError('err.xlsx.unknownDocumentType', getLocale()));
    }
    const docId = str('docId');
    if (!UUID_RE.test(docId))
      throw new BadRequestException(translateError('err.xlsx.invalidDocumentId', getLocale()));

    const mapping: ImportMapping = {
      startRow: num('startRow') ?? 2,
      codeCol: num('codeCol'),
      articleCol: num('articleCol'),
      brandCol: num('brandCol'),
      barcodeCol: num('barcodeCol'),
      nameCol: num('nameCol'),
      quantityCol: num('quantityCol'),
      priceCol: num('priceCol'),
    };

    const rows = await this.xlsxService.previewImport(
      orgId,
      docType,
      docId,
      buffer,
      filename,
      mapping,
    );
    return { rows };
  }

  @Post('import/raw-preview')
  @Roles('OWNER', 'ADMIN', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'Сирий передперегляд Excel (перші рядки як текстова сітка)' })
  @ApiConsumes('multipart/form-data')
  async rawPreviewImport(@Request() req: FastifyRequest) {
    const { buffer, filename } = await this.readImportFile(req, 'document');
    return this.xlsxService.rawPreview(buffer, filename, 20);
  }

  @Post('import/apply')
  @Roles('OWNER', 'ADMIN', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'Застосувати вирішені рядки generic-імпорту' })
  async applyImport(
    @OrgContext() orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ApplyImportDto,
  ) {
    await this.xlsxService.applyImport(orgId, dto.docType, dto.docId, dto.rows, user.id, dto.mode);
    return { ok: true };
  }

  // ─── Helper ───────────────────────────────────────────────────────────────────

  /**
   * BR-SEC-UPLOAD: дістати й ПЕРЕВІРИТИ файл імпорту одним кроком — розмір, розширення й (для
   * .xlsx) магічні байти до будь-якого розбору. `kind` задає допустимі розширення ендпоінта.
   */
  private async readImportFile(
    req: FastifyRequest,
    kind: ImportFileKind,
  ): Promise<{ buffer: Buffer; filename: string; file: MultipartFile }> {
    const file = await this.getUploadedFile(req);
    const filename = file.filename ?? '';
    const buffer = assertImportFile(await file.toBuffer(), filename, kind);
    return { buffer, filename, file };
  }

  private async getUploadedFile(req: FastifyRequest): Promise<MultipartFile> {
    // fastify-multipart throws FastifyError "the request is not multipart" with 406
    // when content-type is not multipart. Catch to return a friendly 400 in Ukrainian instead.
    let data: MultipartFile | undefined;
    try {
      data = await req.file();
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : translateError('err.xlsx.rowErrorUnknown', getLocale());
      throw new BadRequestException(
        translateError('err.xlsx.fileNotUploadedDetail', getLocale(), {
          detail: msg.includes('not multipart')
            ? translateError('err.xlsx.fileNotUploadedMultipart', getLocale())
            : msg,
        }),
      );
    }
    if (!data)
      throw new BadRequestException(translateError('err.xlsx.fileNotUploaded', getLocale()));
    return data;
  }
}
