import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { InspectionService } from './inspection.service';
import { CreateInspectionDto } from './inspection.dto';

@ApiTags('inspection')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('work-orders/:workOrderId/inspection')
export class InspectionController {
  constructor(private readonly service: InspectionService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Отримати звіт огляду наряду' })
  findOne(
    @Param('workOrderId', ParseUUIDPipe) workOrderId: string,
    @CurrentUser() user: { orgId: string },
  ) {
    return this.service.findByWorkOrder(user.orgId, workOrderId);
  }

  @Get('default-points')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Дефолтні точки огляду' })
  getDefaultPoints() {
    return this.service.getDefaultPoints();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Створити звіт огляду' })
  create(
    @Param('workOrderId', ParseUUIDPipe) workOrderId: string,
    @Body() dto: CreateInspectionDto,
    @CurrentUser() user: { orgId: string; id: string },
  ) {
    return this.service.create(user.orgId, workOrderId, dto, user.id);
  }
}
