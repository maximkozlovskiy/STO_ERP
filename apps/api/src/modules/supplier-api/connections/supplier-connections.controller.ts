import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  supplierConnectionCreateSchema,
  supplierConnectionUpdateSchema,
  type SupplierConnectionCreateValues,
  type SupplierConnectionUpdateValues,
} from '@sto/shared';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { OrgContext } from '../../../auth/decorators/org-context.decorator';
import { SupplierAdapterRegistry } from '../adapters/supplier-adapter-registry';
import { SupplierConnectionsService } from './supplier-connections.service';
import {
  PaginatedSupplierConnectionsDto,
  SupplierConnectionResponseDto,
  SupplierProviderInfoDto,
  SupplierQueuedResponseDto,
} from './supplier-connections.dto';

/** Підключення до API постачальників — лише власник і адміністратор (BR-SCON-001). */
export const SCON_ADMIN_ROLES = ['OWNER', 'ADMIN'] as const;

@ApiTags('Supplier API')
@Controller('supplier-providers')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class SupplierProvidersController {
  constructor(private readonly registry: SupplierAdapterRegistry) {}

  @Get()
  @Roles(...SCON_ADMIN_ROLES)
  @ApiOperation({
    summary: 'Постачальники API: можливості, поля кредів і параметрів (BR-SCON-003)',
  })
  @ApiOkResponse({ type: [SupplierProviderInfoDto] })
  list(): SupplierProviderInfoDto[] {
    return this.registry.list();
  }
}

@ApiTags('Supplier API')
@Controller('supplier-connections')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class SupplierConnectionsController {
  constructor(private readonly service: SupplierConnectionsService) {}

  @Get()
  @Roles(...SCON_ADMIN_ROLES)
  @ApiOperation({ summary: 'Підключення до API постачальників' })
  @ApiOkResponse({ type: PaginatedSupplierConnectionsDto })
  findAll(@OrgContext() orgId: string) {
    return this.service.findAll(orgId);
  }

  @Post()
  @Roles(...SCON_ADMIN_ROLES)
  @ApiOperation({ summary: 'Нове підключення (BR-SCON-001…003)' })
  @ApiOkResponse({ type: SupplierConnectionResponseDto })
  create(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(supplierConnectionCreateSchema))
    dto: SupplierConnectionCreateValues,
  ) {
    return this.service.create(orgId, dto);
  }

  @Post(':id/verify')
  @Roles(...SCON_ADMIN_ROLES)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Перевірити підключення — через чергу (BR-SCON-004)' })
  @ApiOkResponse({ type: SupplierQueuedResponseDto })
  verify(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.requestVerify(orgId, id);
  }

  @Get(':id')
  @Roles(...SCON_ADMIN_ROLES)
  @ApiOkResponse({ type: SupplierConnectionResponseDto })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Patch(':id')
  @Roles(...SCON_ADMIN_ROLES)
  @ApiOperation({
    summary: 'Змінити підключення; креди зливаються, порожнє не стирає (BR-SCON-002)',
  })
  @ApiOkResponse({ type: SupplierConnectionResponseDto })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(supplierConnectionUpdateSchema))
    dto: SupplierConnectionUpdateValues,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles(...SCON_ADMIN_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }
}
