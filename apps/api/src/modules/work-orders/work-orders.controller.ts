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
  Res,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiProduces,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { WorkOrdersService } from './work-orders.service';
import { WorkOrderShareService } from './work-order-share.service';
import {
  workOrderCreateSchema,
  workOrderUpdateSchema,
  workOrderLineSchema,
  workOrderLineUpdateSchema,
  workOrderPartSchema,
  workOrderPartUpdateSchema,
  type WorkOrderCreateValues,
  type WorkOrderUpdateValues,
  type WorkOrderLineValues,
  type WorkOrderLineUpdateValues,
  type WorkOrderPartValues,
  type WorkOrderPartUpdateValues,
} from '@sto/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  TransitionWorkOrderDto,
  WorkOrderQueryDto,
  SendEstimateSmsDto,
  LinkedCountsDto,
  WorkOrderResponseDto,
  WorkOrderDetailDto,
  WorkOrderLineResponseDto,
  WorkOrderPartResponseDto,
  PaginatedWorkOrdersDto,
  WorkOrderShareTokenResponseDto,
  WorkOrderLinkedDocumentsDto,
  WorkOrderLinkedCountsEntryDto,
} from './work-orders.dto';

@ApiTags('Work Orders')
@Controller('work-orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
@ApiExtraModels(WorkOrderLinkedCountsEntryDto)
export class WorkOrdersController {
  constructor(
    private readonly service: WorkOrdersService,
    private readonly shareService: WorkOrderShareService,
  ) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Список нарядів' })
  @ApiOkResponse({ type: PaginatedWorkOrdersDto })
  findAll(@OrgContext() orgId: string, @Query() query: WorkOrderQueryDto) {
    return this.service.findAll(orgId, query);
  }

  // ─── Linked Documents ─────────────────────────────────
  // Специфічні маршрути ПЕРЕД @Get(':id') — Fastify route ordering

  @Get(':id/linked-documents')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT')
  @ApiOperation({ summary: "Пов'язані документи наряду (рахунки, оплати, слоти, гарантії)" })
  @ApiOkResponse({ type: WorkOrderLinkedDocumentsDto })
  getLinkedDocuments(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getLinkedDocuments(orgId, id);
  }

  @Post('linked-counts')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Кількість пов'язаних документів для списку нарядів (batch)" })
  // Відповідь — мапа ID → лічильники. Клас із index-signature Swagger не читає
  // (нема властивостей для рефлексії), тож схема задається явно.
  @ApiOkResponse({
    schema: {
      type: 'object',
      additionalProperties: { $ref: getSchemaPath(WorkOrderLinkedCountsEntryDto) },
    },
  })
  getLinkedCounts(@OrgContext() orgId: string, @Body() dto: LinkedCountsDto) {
    return this.service.getLinkedCounts(orgId, dto.workOrderIds);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Деталі наряду' })
  @ApiOkResponse({ type: WorkOrderDetailDto })
  findOne(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { role: string },
  ) {
    // §2.1 Auth: pass role → service маскує part.costPrice для MECHANIC/RECEPTIONIST
    return this.service.findOne(orgId, id, user.role);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @UseInterceptors(IdempotencyInterceptor) // A1: дедуплікація create під offline-retry
  @ApiOperation({ summary: 'Створити наряд' })
  @ApiCreatedResponse({ type: WorkOrderResponseDto })
  create(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Body(new ZodValidationPipe(workOrderCreateSchema)) dto: WorkOrderCreateValues,
  ) {
    return this.service.create(orgId, dto, user.id);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Оновити наряд' })
  @ApiOkResponse({ type: WorkOrderResponseDto })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(workOrderUpdateSchema)) dto: WorkOrderUpdateValues,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.update(orgId, id, dto, user.id);
  }

  @Get(':id/pdf')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Завантажити наряд у PDF' })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'PDF-файл наряду', schema: { type: 'string', format: 'binary' } })
  async downloadPdf(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const buffer = await this.service.generatePdf(orgId, id);
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="work-order-${id}.pdf"`)
      .send(buffer);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити чернетку наряду' })
  @ApiNoContentResponse()
  remove(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(orgId, id, user.id);
  }

  @Post(':id/transition')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Змінити статус наряду (FSM)' })
  @ApiOkResponse({ type: WorkOrderResponseDto })
  transition(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionWorkOrderDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.transition(orgId, id, dto.status, user.id);
  }

  @Post(':id/clone')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Дублювати наряд' })
  @ApiCreatedResponse({ type: WorkOrderResponseDto })
  clone(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.clone(orgId, id, user.id);
  }

  // ─── Estimate Share ──────────────────────────────────────

  @Post(':id/share-token')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Отримати або створити share-токен для кошторису' })
  @ApiOkResponse({ type: WorkOrderShareTokenResponseDto })
  getShareToken(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.shareService.getOrCreateShareToken(orgId, id);
  }

  @Post(':id/send-estimate-sms')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Надіслати кошторис клієнту через SMS' })
  @ApiOkResponse({ description: 'SMS поставлено у чергу (тіло порожнє)' })
  sendEstimateSms(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    // baseUrl навмисно НЕ приймається з тіла — формується на сервері (open-redirect ризик).
    // DTO залишено порожнім + ValidationPipe whitelist=true → зайві поля 400.
    @Body() _dto: SendEstimateSmsDto,
  ) {
    return this.shareService.sendEstimateSms(orgId, id);
  }

  // ─── Lines ───────────────────────────────────────────────

  @Post(':id/lines')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Додати роботу до наряду' })
  @ApiCreatedResponse({ type: WorkOrderLineResponseDto })
  addLine(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(workOrderLineSchema)) dto: WorkOrderLineValues,
  ) {
    return this.service.addLine(orgId, id, dto);
  }

  @Patch(':id/lines/:lineId')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Оновити рядок роботи' })
  @ApiOkResponse({ type: WorkOrderLineResponseDto })
  updateLine(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body(new ZodValidationPipe(workOrderLineUpdateSchema)) dto: WorkOrderLineUpdateValues,
  ) {
    return this.service.updateLine(orgId, id, lineId, dto);
  }

  @Delete(':id/lines/:lineId')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити рядок роботи' })
  @ApiNoContentResponse()
  removeLine(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
  ) {
    return this.service.removeLine(orgId, id, lineId);
  }

  // ─── Parts ───────────────────────────────────────────────

  @Post(':id/parts')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Додати запчастину до наряду' })
  @ApiCreatedResponse({ type: WorkOrderPartResponseDto })
  addPart(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(workOrderPartSchema)) dto: WorkOrderPartValues,
    // role passed to service so OWNER/ADMIN see costPrice immediately after addPart
    // (fail-closed default = undefined; without role they'd need a full page refresh).
    @CurrentUser() user: { role: string },
  ) {
    return this.service.addPart(orgId, id, dto, user.role);
  }

  @Patch(':id/parts/:partId')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Оновити запчастину наряду' })
  @ApiOkResponse({ type: WorkOrderPartResponseDto })
  updatePart(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('partId', ParseUUIDPipe) partId: string,
    @Body(new ZodValidationPipe(workOrderPartUpdateSchema)) dto: WorkOrderPartUpdateValues,
    @CurrentUser() user: { role: string },
  ) {
    return this.service.updatePart(orgId, id, partId, dto, user.role);
  }

  @Delete(':id/parts/:partId')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити запчастину наряду' })
  @ApiNoContentResponse()
  removePart(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('partId', ParseUUIDPipe) partId: string,
  ) {
    return this.service.removePart(orgId, id, partId);
  }
}
