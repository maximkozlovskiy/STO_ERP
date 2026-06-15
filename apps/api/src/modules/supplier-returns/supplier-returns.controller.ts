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
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { SupplierReturnsService } from './supplier-returns.service';
import {
  CreateSupplierReturnDto,
  UpdateSupplierReturnDto,
  SupplierReturnQueryDto,
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
  create(@OrgContext() orgId: string, @Body() dto: CreateSupplierReturnDto) {
    return this.service.create(orgId, dto);
  }

  @Get()
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Список повернень постачальнику' })
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

  // Specific sub-routes BEFORE :id (Fastify route ordering rule)
  @Post(':id/confirm')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Підтвердити повернення (WRITEOFF + REFUND)' })
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
  cancel(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.cancel(orgId, id);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Деталі повернення' })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Оновити повернення (тільки DRAFT)' })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierReturnDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити повернення (soft delete, тільки DRAFT)' })
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }
}
