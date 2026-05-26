import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Res, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { WorkOrdersService } from './work-orders.service';
import {
  CreateWorkOrderDto, UpdateWorkOrderDto, TransitionWorkOrderDto, WorkOrderQueryDto,
  CreateWorkOrderLineDto, UpdateWorkOrderLineDto,
  CreateWorkOrderPartDto, UpdateWorkOrderPartDto,
} from './work-orders.dto';

@ApiTags('Work Orders')
@Controller('work-orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class WorkOrdersController {
  constructor(private readonly service: WorkOrdersService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Список нарядів' })
  findAll(@OrgContext() orgId: string, @Query() query: WorkOrderQueryDto) {
    return this.service.findAll(orgId, query);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Деталі наряду' })
  findOne(@OrgContext() orgId: string, @Param('id') id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Створити наряд' })
  create(@OrgContext() orgId: string, @Body() dto: CreateWorkOrderDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Оновити наряд' })
  update(@OrgContext() orgId: string, @Param('id') id: string, @Body() dto: UpdateWorkOrderDto) {
    return this.service.update(orgId, id, dto);
  }

  @Get(':id/pdf')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Завантажити наряд у PDF' })
  async downloadPdf(
    @OrgContext() orgId: string,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const buffer = await this.service.generatePdf(orgId, id);
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="work-order-${id}.pdf"`)
      .send(buffer);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити чернетку наряду' })
  remove(@OrgContext() orgId: string, @Param('id') id: string) {
    return this.service.remove(orgId, id);
  }

  @Post(':id/transition')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Змінити статус наряду (FSM)' })
  transition(
    @OrgContext() orgId: string,
    @Param('id') id: string,
    @Body() dto: TransitionWorkOrderDto,
    @CurrentUser() user: { sub: string },
  ) {
    return this.service.transition(orgId, id, dto.status, user?.sub);
  }

  // ─── Lines ───────────────────────────────────────────────

  @Post(':id/lines')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Додати роботу до наряду' })
  addLine(@OrgContext() orgId: string, @Param('id') id: string, @Body() dto: CreateWorkOrderLineDto) {
    return this.service.addLine(orgId, id, dto);
  }

  @Patch(':id/lines/:lineId')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Оновити рядок роботи' })
  updateLine(
    @OrgContext() orgId: string,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: UpdateWorkOrderLineDto,
  ) {
    return this.service.updateLine(orgId, id, lineId, dto);
  }

  @Delete(':id/lines/:lineId')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити рядок роботи' })
  removeLine(@OrgContext() orgId: string, @Param('id') id: string, @Param('lineId') lineId: string) {
    return this.service.removeLine(orgId, id, lineId);
  }

  // ─── Parts ───────────────────────────────────────────────

  @Post(':id/parts')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Додати запчастину до наряду' })
  addPart(@OrgContext() orgId: string, @Param('id') id: string, @Body() dto: CreateWorkOrderPartDto) {
    return this.service.addPart(orgId, id, dto);
  }

  @Patch(':id/parts/:partId')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Оновити запчастину наряду' })
  updatePart(
    @OrgContext() orgId: string,
    @Param('id') id: string,
    @Param('partId') partId: string,
    @Body() dto: UpdateWorkOrderPartDto,
  ) {
    return this.service.updatePart(orgId, id, partId, dto);
  }

  @Delete(':id/parts/:partId')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити запчастину наряду' })
  removePart(@OrgContext() orgId: string, @Param('id') id: string, @Param('partId') partId: string) {
    return this.service.removePart(orgId, id, partId);
  }
}
