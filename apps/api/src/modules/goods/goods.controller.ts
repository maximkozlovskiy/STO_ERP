import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { GoodsService } from './goods.service';
import {
  CreateGoodDto,
  UpdateGoodDto,
  GoodQueryDto,
  CreateGoodUoMDto,
  UpdateGoodUoMDto,
  GoodUoMResponseDto,
} from './goods.dto';
import { CreateGoodBarcodeDto, GoodBarcodeResponseDto } from './barcodes.dto';
import { BatchService } from '../inventory/batch.service';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('Goods')
@Controller('goods')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class GoodsController {
  constructor(
    private readonly service: GoodsService,
    private readonly batchService: BatchService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'STOREKEEPER', 'MECHANIC')
  @ApiOperation({ summary: 'Список товарів/запчастин' })
  findAll(@OrgContext() orgId: string, @Query() query: GoodQueryDto) {
    return this.service.findAll(orgId, query);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'STOREKEEPER', 'MECHANIC')
  @ApiOperation({ summary: 'Отримати товар' })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Створити товар' })
  create(@OrgContext() orgId: string, @Body() dto: CreateGoodDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Оновити товар' })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGoodDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити товар' })
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }

  // ─── UoM Sub-resource ────────────────────────────────────────────────────────

  @Get(':goodId/uoms')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Одиниці виміру товару' })
  getUoMs(
    @OrgContext() orgId: string,
    @Param('goodId', ParseUUIDPipe) goodId: string,
  ): Promise<GoodUoMResponseDto[]> {
    return this.service.getUoMs(orgId, goodId);
  }

  @Post(':goodId/uoms')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Додати одиницю виміру до товару' })
  addUoM(
    @OrgContext() orgId: string,
    @Param('goodId', ParseUUIDPipe) goodId: string,
    @Body() dto: CreateGoodUoMDto,
  ): Promise<GoodUoMResponseDto> {
    return this.service.addUoM(orgId, goodId, dto);
  }

  @Patch(':goodId/uoms/:uomId')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Оновити коефіцієнт та розміри одиниці виміру товару' })
  updateUoM(
    @OrgContext() orgId: string,
    @Param('goodId', ParseUUIDPipe) goodId: string,
    @Param('uomId', ParseUUIDPipe) uomId: string,
    @Body() dto: UpdateGoodUoMDto,
  ): Promise<GoodUoMResponseDto> {
    return this.service.updateUoM(orgId, goodId, uomId, dto);
  }

  @Patch(':goodId/uoms/:uomId/default')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Встановити одиницю виміру як основну' })
  setDefaultUoM(
    @OrgContext() orgId: string,
    @Param('goodId', ParseUUIDPipe) goodId: string,
    @Param('uomId', ParseUUIDPipe) uomId: string,
  ): Promise<GoodUoMResponseDto> {
    return this.service.setDefaultUoM(orgId, goodId, uomId);
  }

  @Delete(':goodId/uoms/:uomId')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити одиницю виміру з товару' })
  removeUoM(
    @OrgContext() orgId: string,
    @Param('goodId', ParseUUIDPipe) goodId: string,
    @Param('uomId', ParseUUIDPipe) uomId: string,
  ): Promise<void> {
    return this.service.removeUoM(orgId, goodId, uomId);
  }

  // ─── Barcodes Sub-resource ───────────────────────────────────────────────────

  @Get(':goodId/barcodes')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Штрихкоди товару' })
  getBarcodes(@OrgContext() orgId: string, @Param('goodId', ParseUUIDPipe) goodId: string) {
    return this.service.getBarcodes(orgId, goodId);
  }

  @Post(':goodId/barcodes')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Додати штрихкод' })
  createBarcode(
    @OrgContext() orgId: string,
    @Param('goodId', ParseUUIDPipe) goodId: string,
    @Body() dto: CreateGoodBarcodeDto,
  ): Promise<GoodBarcodeResponseDto> {
    return this.service.createBarcode(orgId, goodId, dto);
  }

  @Delete(':goodId/barcodes/:barcodeId')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити штрихкод' })
  deleteBarcode(
    @OrgContext() orgId: string,
    @Param('goodId', ParseUUIDPipe) goodId: string,
    @Param('barcodeId', ParseUUIDPipe) barcodeId: string,
  ) {
    return this.service.deleteBarcode(orgId, goodId, barcodeId);
  }

  // ─── Batches + Price History Sub-resources ───────────────────────────────────
  //
  // Bug #28: list-style sub-resources повертають `{ items, total }` shape для
  // відповідності API-контракту STO ERP (frontend всюди очікує `data.items.length`).
  // Bug #31: перед запитом валідуємо існування Good у поточній org → 404 інакше
  // силует "Немає партій" приховує помилковий goodId.
  // Bug #120/#121: `total` повинен бути реальним COUNT з БД, а не `items.length`
  // (яке cap-ується `take` у service/query). Інакше повторюємо Bug #88 регрес.

  @Get(':id/batches')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Партії товару' })
  async getBatches(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('warehouseId', new ParseUUIDPipe({ optional: true })) warehouseId?: string,
  ) {
    const good = await this.prisma.good.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!good) throw new NotFoundException('Товар не знайдено');
    const [items, total] = await Promise.all([
      this.batchService.getBatchesForGood(orgId, id, warehouseId),
      this.prisma.stockBatch.count({
        where: { orgId, goodId: id, ...(warehouseId ? { warehouseId } : {}) },
      }),
    ]);
    return { items, total };
  }

  @Get(':id/price-history')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Цінова історія товару' })
  async getPriceHistory(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    const good = await this.prisma.good.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!good) throw new NotFoundException('Товар не знайдено');
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.priceHistory.findMany({
        where: { orgId, goodId: id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.priceHistory.count({ where: { orgId, goodId: id } }),
    ]);
    const items = rows.map(h => ({
      id: h.id,
      oldPrice: h.oldPrice != null ? Number(h.oldPrice) : null,
      newPrice: Number(h.newPrice),
      costPrice: h.costPrice != null ? Number(h.costPrice) : null,
      reason: h.reason,
      createdAt: h.createdAt,
    }));
    return { items, total };
  }
}
