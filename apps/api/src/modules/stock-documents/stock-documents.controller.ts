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
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
} from '@nestjs/swagger';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { StockDocumentsService } from './stock-documents.service';
import {
  stockDocumentCreateSchema,
  stockDocumentUpdateSchema,
  type StockDocumentCreateValues,
  type StockDocumentUpdateValues,
} from '@sto/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  TransitionStockDocumentDto,
  StockDocumentQueryDto,
  LinkedCountsDto,
  StockDocumentResponseDto,
  PaginatedStockDocumentsDto,
} from './stock-documents.dto';

@ApiTags('Stock Documents')
@Controller('stock-documents')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class StockDocumentsController {
  constructor(private readonly service: StockDocumentsService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Список складських документів' })
  @ApiOkResponse({ type: PaginatedStockDocumentsDto })
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
  @ApiOperation({ summary: 'Складський документ по ID' })
  @ApiOkResponse({ type: StockDocumentResponseDto })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @UseInterceptors(IdempotencyInterceptor) // A1: дедуплікація create під offline-retry
  @ApiOperation({ summary: 'Створити складський документ' })
  @ApiCreatedResponse({ type: StockDocumentResponseDto })
  create(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(stockDocumentCreateSchema)) dto: StockDocumentCreateValues,
  ) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Оновити чернетку документа' })
  @ApiOkResponse({ type: StockDocumentResponseDto })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(stockDocumentUpdateSchema)) dto: StockDocumentUpdateValues,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити чернетку документа' })
  @ApiNoContentResponse()
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }

  @Post(':id/transition')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Змінити статус документа (FSM)' })
  @ApiOkResponse({ type: StockDocumentResponseDto })
  transition(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionStockDocumentDto,
    @CurrentUser() user: { id: string },
  ) {
    // jwt.strategy.ts повертає { id, orgId, role }. Поле `sub` живе тільки у JWT payload, не в request.user.
    return this.service.transition(orgId, id, dto.status, user?.id);
  }
}
