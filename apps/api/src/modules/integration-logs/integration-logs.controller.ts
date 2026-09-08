import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { IntegrationLogService } from './integration-log.service';

@ApiTags('IntegrationLogs')
@Controller('integration-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class IntegrationLogsController {
  constructor(private readonly service: IntegrationLogService) {}

  @Get()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Логи зовнішніх обмінів (метадані)' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'provider', required: false })
  @ApiQuery({ name: 'operation', required: false })
  @ApiQuery({ name: 'ok', required: false, description: 'true=успіх, false=помилки' })
  @ApiQuery({ name: 'documentType', required: false })
  @ApiQuery({ name: 'dateFrom', required: false })
  @ApiQuery({ name: 'dateTo', required: false })
  findAll(
    @OrgContext() orgId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('provider') provider?: string,
    @Query('operation') operation?: string,
    @Query('ok') ok?: string,
    @Query('documentType') documentType?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    // ok: 'true'|'false' рядок → boolean | undefined (undefined = без фільтра)
    const okBool = ok === 'true' ? true : ok === 'false' ? false : undefined;
    return this.service.findAll(
      orgId,
      +page,
      +limit,
      provider,
      operation,
      okBool,
      documentType,
      dateFrom,
      dateTo,
    );
  }
}
