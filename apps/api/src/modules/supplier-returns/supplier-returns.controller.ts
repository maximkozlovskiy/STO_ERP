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
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { SupplierReturnsService } from './supplier-returns.service';
import {
  supplierReturnCreateSchema,
  supplierReturnUpdateSchema,
  type SupplierReturnCreateValues,
  type SupplierReturnUpdateValues,
} from '@sto/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  SupplierReturnQueryDto,
  LinkedCountsDto,
  SupplierReturnResponseDto,
  PaginatedSupplierReturnsDto,
} from './supplier-returns.dto';

@ApiTags('Supplier Returns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('supplier-returns')
export class SupplierReturnsController {
  constructor(private readonly service: SupplierReturnsService) {}

  @Post()
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Створити повернення постачальнику' })
  @ApiCreatedResponse({ type: SupplierReturnResponseDto })
  create(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(supplierReturnCreateSchema)) dto: SupplierReturnCreateValues,
  ) {
    return this.service.create(orgId, dto);
  }

  @Get()
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Список повернень постачальнику' })
  @ApiOkResponse({ type: PaginatedSupplierReturnsDto })
  findAll(@OrgContext() orgId: string, @Query() query: SupplierReturnQueryDto) {
    return this.service.findAll(
      orgId,
      query.page ? parseInt(query.page, 10) : 1,
      query.limit ? parseInt(query.limit, 10) : 20,
      query.status,
      query.q,
      query.showDeleted === 'true',
      query.dateFrom,
      query.dateTo,
    );
  }

  @Post('linked-counts')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Кількість пов'язаних документів для списку повернень (batch)" })
  getLinkedCounts(@OrgContext() orgId: string, @Body() dto: LinkedCountsDto) {
    return this.service.getLinkedCounts(orgId, dto.ids);
  }

  // Specific sub-routes BEFORE :id (Fastify route ordering rule)
  @Post(':id/confirm')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Підтвердити повернення (WRITEOFF + REFUND)' })
  @ApiOkResponse({ type: SupplierReturnResponseDto })
  confirm(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.confirm(orgId, id, user.id);
  }

  @Post(':id/cancel')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Скасувати повернення' })
  @ApiOkResponse({ type: SupplierReturnResponseDto })
  cancel(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.cancel(orgId, id);
  }

  // Оголошено ПЕРЕД @Get(':id') — інакше Fastify матчить 'linked-documents' як :id.
  @Get(':id/linked-documents')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: "Пов'язані документи повернення (замовлення, постачальник, склад)" })
  getLinkedDocuments(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getLinkedDocuments(orgId, id);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Деталі повернення' })
  @ApiOkResponse({ type: SupplierReturnResponseDto })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Оновити повернення (тільки DRAFT)' })
  @ApiOkResponse({ type: SupplierReturnResponseDto })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(supplierReturnUpdateSchema)) dto: SupplierReturnUpdateValues,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити повернення (soft delete, тільки DRAFT)' })
  @ApiNoContentResponse()
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }
}
