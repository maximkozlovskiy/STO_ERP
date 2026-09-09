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
  UseInterceptors,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { StockDocumentsService } from './stock-documents.service';
import {
  CreateStockDocumentDto,
  UpdateStockDocumentDto,
  TransitionStockDocumentDto,
  DocTransitionStatus,
  StockDocumentQueryDto,
  LinkedCountsDto,
} from './stock-documents.dto';

@ApiTags('Stock Documents')
@Controller('stock-documents')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class StockDocumentsController {
  constructor(private readonly service: StockDocumentsService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'РЎРїРёСЃРѕРє СЃРєР»Р°РґСЃСЊРєРёС… РґРѕРєСѓРјРµРЅС‚С–РІ' })
  findAll(@OrgContext() orgId: string, @Query() query: StockDocumentQueryDto) {
    return this.service.findAll(
      orgId,
      query.page,
      query.limit,
      query.type,
      query.status,
      query.showDeleted === 'true',
      query.dateFrom,
      query.dateTo,
      query.sortBy,
      query.sortDir,
    );
  }

  // Оголошено ПЕРЕД @Get(':id') — інакше Fastify матчить 'linked-documents' як :id.
  @Get(':id/linked-documents')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: "Пов'язані документи складського документа (замовлення, склади)" })
  getLinkedDocuments(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getLinkedDocuments(orgId, id);
  }

  @Post('linked-counts')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Кількість пов'язаних документів для списку (batch)" })
  getLinkedCounts(@OrgContext() orgId: string, @Body() dto: LinkedCountsDto) {
    return this.service.getLinkedCounts(orgId, dto.ids);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'РЎРєР»Р°РґСЃСЊРєРёР№ РґРѕРєСѓРјРµРЅС‚ РїРѕ ID' })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @UseInterceptors(IdempotencyInterceptor) // A1: дедуплікація create під offline-retry
  @ApiOperation({ summary: 'РЎС‚РІРѕСЂРёС‚Рё СЃРєР»Р°РґСЃСЊРєРёР№ РґРѕРєСѓРјРµРЅС‚' })
  create(@OrgContext() orgId: string, @Body() dto: CreateStockDocumentDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'РћРЅРѕРІРёС‚Рё С‡РµСЂРЅРµС‚РєСѓ РґРѕРєСѓРјРµРЅС‚Р°' })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStockDocumentDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Р’РёРґР°Р»РёС‚Рё С‡РµСЂРЅРµС‚РєСѓ РґРѕРєСѓРјРµРЅС‚Р°' })
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }

  @Post(':id/transition')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Р—РјС–РЅРёС‚Рё СЃС‚Р°С‚СѓСЃ РґРѕРєСѓРјРµРЅС‚Р° (FSM)' })
  transition(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionStockDocumentDto,
    @CurrentUser() user: { id: string },
  ) {
    // jwt.strategy.ts повертає { id, orgId, role }. Поле `sub` живе тільки у JWT payload, не в request.user.
    return this.service.transition(orgId, id, dto.status as DocTransitionStatus, user?.id);
  }
}
