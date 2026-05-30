import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { WorkOrderTemplatesService } from './work-order-templates.service';
import {
  CreateWorkOrderTemplateDto,
  UpdateWorkOrderTemplateDto,
  WorkOrderTemplateResponseDto,
  WorkOrderTemplatesListDto,
} from './work-order-templates.dto';

@ApiTags('Work Order Templates')
@Controller('work-order-templates')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class WorkOrderTemplatesController {
  constructor(private readonly service: WorkOrderTemplatesService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Список шаблонів нарядів' })
  findAll(@OrgContext() orgId: string): Promise<WorkOrderTemplatesListDto> {
    return this.service.findAll(orgId);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Шаблон за ID' })
  findOne(
    @OrgContext() orgId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<WorkOrderTemplateResponseDto> {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Створити шаблон' })
  create(
    @OrgContext() orgId: string,
    @Body() dto: CreateWorkOrderTemplateDto,
  ): Promise<WorkOrderTemplateResponseDto> {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Оновити шаблон' })
  update(
    @OrgContext() orgId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateWorkOrderTemplateDto,
  ): Promise<WorkOrderTemplateResponseDto> {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити шаблон' })
  remove(@OrgContext() orgId: string, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.service.remove(orgId, id);
  }
}
