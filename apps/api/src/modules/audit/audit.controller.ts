import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { AuditService } from './audit.service';

@ApiTags('audit')
@Controller('audit')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class AuditController {
  constructor(private readonly service: AuditService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Журнал змін сутності' })
  @ApiQuery({ name: 'entityType', required: true })
  @ApiQuery({ name: 'entityId', required: true })
  findByEntity(
    @OrgContext() orgId: string,
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
  ) {
    return this.service.findByEntity(orgId, entityType, entityId);
  }
}
