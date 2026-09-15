import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import {
  ImportMappingResponseDto,
  UpsertImportMappingDto,
} from './counterparty-import-mappings.dto';
import { CounterpartyImportMappingsService } from './counterparty-import-mappings.service';

@ApiTags('Мапінг імпорту контрагента')
@Controller('counterparties')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class CounterpartyImportMappingsController {
  constructor(private readonly service: CounterpartyImportMappingsService) {}

  @Get(':id/import-mapping')
  @Roles('OWNER', 'ADMIN', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'Отримати збережений мапінг колонок Excel контрагента' })
  @ApiResponse({ status: 200, type: ImportMappingResponseDto })
  get(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(orgId, id);
  }

  @Put(':id/import-mapping')
  @Roles('OWNER', 'ADMIN', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'Зберегти мапінг колонок Excel контрагента' })
  @ApiResponse({ status: 200, type: ImportMappingResponseDto })
  upsert(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertImportMappingDto,
  ) {
    return this.service.upsert(orgId, id, dto);
  }
}
