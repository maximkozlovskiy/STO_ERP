import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
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
  ApiExtraModels,
  ApiProduces,
  getSchemaPath,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { InvoicesService } from './invoices.service';
import {
  invoiceHeaderSchema,
  invoiceUpdateSchema,
  invoiceLineSchema,
  invoiceLineUpdateSchema,
  type InvoiceHeaderValues,
  type InvoiceUpdateValues,
  type InvoiceLineValues,
  type InvoiceLineUpdateValues,
} from '@sto/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  TransitionInvoiceDto,
  InvoiceQueryDto,
  LinkedCountsDto,
  InvoiceResponseDto,
  InvoiceLineResponseDto,
  PaginatedInvoicesDto,
  InvoiceByWorkOrderResponseDto,
  InvoiceLinkedDocumentsDto,
  InvoiceLinkedCountsEntryDto,
} from './invoices.dto';

@ApiTags('Invoices')
@Controller('invoices')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
@ApiExtraModels(InvoiceLinkedCountsEntryDto)
export class InvoicesController {
  constructor(private readonly service: InvoicesService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Список рахунків' })
  @ApiOkResponse({ type: PaginatedInvoicesDto })
  findAll(@OrgContext() orgId: string, @Query() query: InvoiceQueryDto) {
    return this.service.findAll(
      orgId,
      query.page,
      query.limit,
      query.status,
      query.q,
      query.showDeleted === 'true',
      query.dateFrom,
      query.dateTo,
      query.sortBy,
      query.sortDir,
    );
  }

  // ─── Linked Documents ─────────────────────────────────
  // Специфічні маршрути ПЕРЕД @Get(':id') — Fastify route ordering

  @Get(':id/linked-documents')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: "Пов'язані документи рахунку (наряд, оплати, контрагент)" })
  @ApiOkResponse({ type: InvoiceLinkedDocumentsDto })
  getLinkedDocuments(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getLinkedDocuments(orgId, id);
  }

  @Post('linked-counts')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Кількість пов'язаних документів для списку рахунків (batch)" })
  // Мапа ID → лічильники: клас з index-signature Swagger не читає, схема явна.
  @ApiOkResponse({
    schema: {
      type: 'object',
      additionalProperties: { $ref: getSchemaPath(InvoiceLinkedCountsEntryDto) },
    },
  })
  getLinkedCounts(@OrgContext() orgId: string, @Body() dto: LinkedCountsDto) {
    return this.service.getLinkedCounts(orgId, dto.ids);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Рахунок по ID' })
  @ApiOkResponse({ type: InvoiceResponseDto })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @UseInterceptors(IdempotencyInterceptor) // A1: дедуплікація create під offline-retry
  @ApiOperation({ summary: 'Створити рахунок вручну' })
  @ApiCreatedResponse({ type: InvoiceResponseDto })
  create(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(invoiceHeaderSchema)) dto: InvoiceHeaderValues,
    @CurrentUser() user: { id: string },
  ) {
    // @CurrentUser повертає { id, orgId, role } (jwt.strategy.ts), не { sub } — user.sub завжди undefined.
    return this.service.create(orgId, dto, user?.id);
  }

  // Fastify route ordering: specific sub-routes BEFORE the base :workOrderId route.
  @Post('from-work-order/:workOrderId/refresh')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Перезаписати існуючий рахунок рядками з наряду' })
  @ApiOkResponse({ type: InvoiceResponseDto })
  refreshFromWorkOrder(
    @OrgContext() orgId: string,
    @Param('workOrderId', ParseUUIDPipe) workOrderId: string,
  ) {
    return this.service.refreshFromWorkOrder(orgId, workOrderId);
  }

  @Get('from-work-order/:workOrderId/find')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Знайти рахунок за нарядом (id, number, status, amount, documentDate)' })
  @ApiOkResponse({ type: InvoiceByWorkOrderResponseDto })
  findByWorkOrder(
    @OrgContext() orgId: string,
    @Param('workOrderId', ParseUUIDPipe) workOrderId: string,
  ) {
    return this.service.findByWorkOrder(orgId, workOrderId);
  }

  @Post('from-work-order/:workOrderId')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Виставити рахунок з наряду' })
  @ApiCreatedResponse({ type: InvoiceResponseDto })
  createFromWorkOrder(
    @OrgContext() orgId: string,
    @Param('workOrderId', ParseUUIDPipe) workOrderId: string,
  ) {
    return this.service.createFromWorkOrder(orgId, workOrderId);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Оновити рахунок (тільки DRAFT)' })
  @ApiOkResponse({ type: InvoiceResponseDto })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(invoiceUpdateSchema)) dto: InvoiceUpdateValues,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Post(':id/transition')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Змінити статус рахунку (FSM)' })
  @ApiOkResponse({ type: InvoiceResponseDto })
  transition(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionInvoiceDto,
  ) {
    return this.service.transition(orgId, id, dto.status);
  }

  @Post(':id/clone')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Дублювати рахунок' })
  @ApiCreatedResponse({ type: InvoiceResponseDto })
  clone(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.clone(orgId, id);
  }

  @Get(':id/pdf')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Завантажити рахунок у PDF' })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'PDF-файл рахунку', schema: { type: 'string', format: 'binary' } })
  async downloadPdf(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const buffer = await this.service.generatePdf(orgId, id);
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="invoice-${id}.pdf"`)
      .send(buffer);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити рахунок (тільки DRAFT)' })
  @ApiNoContentResponse()
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }

  @Post(':id/lines')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Додати рядок до рахунку' })
  @ApiCreatedResponse({ type: InvoiceLineResponseDto })
  addLine(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(invoiceLineSchema)) dto: InvoiceLineValues,
  ) {
    return this.service.addLine(orgId, id, dto);
  }

  @Patch(':id/lines/:lineId')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Оновити рядок рахунку' })
  @ApiOkResponse({ type: InvoiceLineResponseDto })
  updateLine(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body(new ZodValidationPipe(invoiceLineUpdateSchema)) dto: InvoiceLineUpdateValues,
  ) {
    return this.service.updateLine(orgId, id, lineId, dto);
  }

  @Delete(':id/lines/:lineId')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити рядок рахунку' })
  @ApiNoContentResponse()
  removeLine(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
  ) {
    return this.service.removeLine(orgId, id, lineId);
  }
}
