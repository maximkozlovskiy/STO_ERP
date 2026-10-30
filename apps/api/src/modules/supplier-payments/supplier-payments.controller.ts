import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiBearerAuth,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
} from '@nestjs/swagger';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { SupplierPaymentsService } from './supplier-payments.service';
import { supplierPaymentCreateSchema, type SupplierPaymentCreateValues } from '@sto/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequireIdempotencyKey } from '../../common/interceptors/idempotency.interceptor';
import {
  WithDeletedQueryPipe,
  WITH_DELETED_API_QUERY,
  type WithDeletedOption,
} from '../../common/pipes/with-deleted-query.pipe';
import {
  SupplierPaymentQueryDto,
  SupplierPaymentScheduleQueryDto,
  SupplierPaymentScheduleDocumentsQueryDto,
  SupplierPaymentResponseDto,
  PaginatedSupplierPaymentsDto,
  SupplierPaymentScheduleDto,
  SupplierPaymentScheduleDocumentDto,
} from './supplier-payments.dto';
import { BadRequestException } from '@nestjs/common';

@ApiTags('Supplier Payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('supplier-payments')
export class SupplierPaymentsController {
  constructor(private readonly service: SupplierPaymentsService) {}

  @Post()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Створити оплату постачальнику (чернетка)' })
  @ApiCreatedResponse({ type: SupplierPaymentResponseDto })
  create(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(supplierPaymentCreateSchema)) dto: SupplierPaymentCreateValues,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.create(orgId, dto, user.id);
  }

  @Get()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Список оплат постачальникам' })
  @ApiOkResponse({ type: PaginatedSupplierPaymentsDto })
  findAll(@OrgContext() orgId: string, @Query() query: SupplierPaymentQueryDto) {
    return this.service.findAll(
      orgId,
      query.page ? parseInt(query.page, 10) : 1,
      query.limit ? parseInt(query.limit, 10) : 20,
      query.status,
      query.supplierId,
      query.q,
      query.showDeleted === 'true',
      query.dateFrom,
      query.dateTo,
      query.sortBy,
      query.sortDir,
      query.purchaseOrderId,
    );
  }

  // Specific sub-routes BEFORE :id (Fastify route ordering rule)
  @Get('schedule')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Графік оплат постачальникам (шахматка по датах)' })
  @ApiOkResponse({ type: SupplierPaymentScheduleDto })
  getSchedule(@OrgContext() orgId: string, @Query() query: SupplierPaymentScheduleQueryDto) {
    return this.service.getSchedule(orgId, query.from, query.to);
  }

  // Drill-down: документи (PO) по яких виникає оплата у клітинці/бакеті шахматки.
  // ПЕРЕД :id (Fastify route ordering). Один route для всіх трьох тригерів кліку.
  @Get('schedule/documents')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Документи (PO) для клітинки графіка оплат' })
  @ApiOkResponse({ type: [SupplierPaymentScheduleDocumentDto] })
  getScheduleDocuments(
    @OrgContext() orgId: string,
    @Query() query: SupplierPaymentScheduleDocumentsQueryDto,
  ) {
    // date XOR target — рівно одне має бути задане (клітинка byDate АБО бакет overdue/planned).
    if ((query.date && query.target) || (!query.date && !query.target)) {
      throw new BadRequestException(
        translateError('err.supplierPayment.dateXorTarget', getLocale()),
      );
    }
    const target = query.date
      ? ({ kind: 'date', date: query.date } as const)
      : ({ kind: query.target! } as const);
    return this.service.getScheduleDocuments(orgId, query.from, query.to, target, query.supplierId);
  }

  @Post(':id/confirm')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @HttpCode(HttpStatus.OK)
  // MV-M2: повтор confirm після обриву відповіді має віддати збережене тіло, а не 400
  // alreadyConfirmedOrChanged (CAS блокує подвоєння проводки, але контракт має бути ідемпотентним).
  // Дзеркаль payments.controller.ts create/reverse.
  @RequireIdempotencyKey()
  @ApiOperation({ summary: 'Провести оплату (settlement PAYMENT)' })
  @ApiOkResponse({ type: SupplierPaymentResponseDto })
  confirm(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.confirm(orgId, id, user.id);
  }

  @Post(':id/cancel')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Скасувати оплату' })
  @ApiOkResponse({ type: SupplierPaymentResponseDto })
  cancel(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.cancel(orgId, id, user?.id);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Деталі оплати постачальнику' })
  @ApiOkResponse({ type: SupplierPaymentResponseDto })
  @ApiQuery(WITH_DELETED_API_QUERY)
  findOne(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('withDeleted', WithDeletedQueryPipe) opts: WithDeletedOption,
  ) {
    // BR-WO-012: прапорець приймає лише цей маршрут — решта викликів findOne бачить невидалені.
    return this.service.findOne(orgId, id, opts);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити оплату (soft delete, крім проведеної)' })
  @ApiNoContentResponse()
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }
}
