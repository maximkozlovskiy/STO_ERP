import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
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
import { ReportBuilderService, FullReportConfig } from './report-builder.service';
import { ReportRunDto, SaveReportDto, UpdateSavedReportDto } from './report-builder.dto';

@ApiTags('Report Builder')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reports/builder')
export class ReportBuilderController {
  constructor(private readonly service: ReportBuilderService) {}

  // ── Специфічні маршрути ПЕРЕД :id (Fastify route ordering) ──

  @Get('metadata')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: "Метадані конструктора: сутності, поля, зв'язки, enum-и" })
  getMetadata() {
    return this.service.getMetadata();
  }

  @Post('run')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Виконати ad-hoc звіт (config → дерево + підсумки)' })
  run(@OrgContext() orgId: string, @Body() dto: ReportRunDto) {
    return this.service.run(orgId, dto.config as unknown as FullReportConfig);
  }

  @Get('saved')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Список збережених звітів' })
  listSaved(@OrgContext() orgId: string) {
    return this.service.listSaved(orgId);
  }

  @Post('saved')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Зберегти звіт' })
  createSaved(
    @OrgContext() orgId: string,
    @Body() dto: SaveReportDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.createSaved(
      orgId,
      { name: dto.name, config: dto.config as unknown as FullReportConfig },
      user.id,
    );
  }

  @Get('saved/:id/run')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Виконати збережений звіт' })
  runSaved(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.runSaved(orgId, id);
  }

  @Get('saved/:id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Отримати збережений звіт' })
  getSaved(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getSaved(orgId, id);
  }

  @Patch('saved/:id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Оновити збережений звіт' })
  updateSaved(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSavedReportDto,
  ) {
    return this.service.updateSaved(orgId, id, {
      name: dto.name,
      config: dto.config as unknown as FullReportConfig | undefined,
    });
  }

  @Delete('saved/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Видалити збережений звіт (soft delete)' })
  removeSaved(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.removeSaved(orgId, id);
  }
}
