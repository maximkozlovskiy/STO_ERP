import { Controller, Get, Query, UseGuards, Header } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { SystemTemplatesService } from './system-templates.service';
import { SystemTemplateResponseDto } from './system-templates.dto';

@ApiTags('System Templates')
@Controller('system-templates')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class SystemTemplatesController {
  constructor(private readonly service: SystemTemplatesService) {}

  @Header('Cache-Control', 'private, max-age=3600')
  @Get()
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Список системних шаблонів довідників' })
  @ApiQuery({
    name: 'entityType',
    required: false,
    description: 'currency | unit_of_measure | payment_method | work_category',
  })
  @ApiResponse({ status: 200, type: [SystemTemplateResponseDto] })
  findAll(@Query('entityType') entityType?: string): Promise<SystemTemplateResponseDto[]> {
    return this.service.findAll(entityType);
  }
}
