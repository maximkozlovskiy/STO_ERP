import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { GoodsService } from './goods.service';
import { CreateGoodDto, UpdateGoodDto, GoodQueryDto } from './goods.dto';
import { CreateGoodBarcodeDto, GoodBarcodeResponseDto } from './barcodes.dto';

@ApiTags('Goods')
@Controller('goods')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class GoodsController {
  constructor(private readonly service: GoodsService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'STOREKEEPER', 'MECHANIC')
  @ApiOperation({ summary: 'Список товарів/запчастин' })
  findAll(@OrgContext() orgId: string, @Query() query: GoodQueryDto) {
    return this.service.findAll(orgId, query);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'STOREKEEPER', 'MECHANIC')
  @ApiOperation({ summary: 'Отримати товар' })
  findOne(@OrgContext() orgId: string, @Param('id') id: string) {
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
  update(@OrgContext() orgId: string, @Param('id') id: string, @Body() dto: UpdateGoodDto) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити товар' })
  remove(@OrgContext() orgId: string, @Param('id') id: string) {
    return this.service.remove(orgId, id);
  }

  // ─── Barcodes Sub-resource ───────────────────────────────────────────────────

  @Get(':goodId/barcodes')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Штрихкоди товару' })
  getBarcodes(@OrgContext() orgId: string, @Param('goodId') goodId: string) {
    return this.service.getBarcodes(orgId, goodId);
  }

  @Post(':goodId/barcodes')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Додати штрихкод' })
  createBarcode(
    @OrgContext() orgId: string,
    @Param('goodId') goodId: string,
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
    @Param('goodId') goodId: string,
    @Param('barcodeId') barcodeId: string,
  ) {
    return this.service.deleteBarcode(orgId, goodId, barcodeId);
  }
}
