import {
  Controller,
  Get,
  Query,
  UseGuards,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { AuditService } from './audit.service';

// Whitelist підтримуваних entityType — захист від випадкового сканування довільних таблиць
// та сюрпризів якщо хтось згодом передасть SQL-щось через DB. Тримати в синхроні з
// місцями де викликається `audit.record(orgId, '<EntityType>', ...)`.
// Типи сутностей, для яких пишеться AuditEvent (whitelist для read-endpoint). Мусить включати
// КОЖЕН entityType, який передається у AuditService.record — інакше журнал пишеться, але його не
// прочитати через API (400). C1a додав Payment; C1b — OrganisationSettings/BranchSettings/TaxRate/
// PricingRule. WorkOrder/Invoice/Counterparty/Vehicle — з попередніх ітерацій.
const AUDIT_ENTITY_TYPES = [
  'WorkOrder',
  'Invoice',
  'Counterparty',
  'Vehicle',
  'Payment',
  'OrganisationSettings',
  'BranchSettings',
  'TaxRate',
  'PricingRule',
] as const;

@ApiTags('audit')
@Controller('audit')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class AuditController {
  constructor(private readonly service: AuditService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Журнал змін сутності' })
  @ApiQuery({ name: 'entityType', required: true, enum: AUDIT_ENTITY_TYPES })
  @ApiQuery({ name: 'entityId', required: true })
  findByEntity(
    @OrgContext() orgId: string,
    @Query('entityType') entityType: string,
    @Query('entityId', new ParseUUIDPipe()) entityId: string,
  ) {
    if (!AUDIT_ENTITY_TYPES.includes(entityType as (typeof AUDIT_ENTITY_TYPES)[number])) {
      throw new BadRequestException('Невідомий тип сутності');
    }
    return this.service.findByEntity(orgId, entityType, entityId);
  }
}
