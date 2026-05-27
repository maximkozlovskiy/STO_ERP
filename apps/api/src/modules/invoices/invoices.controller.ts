import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, Res,
  UseGuards, HttpCode, HttpStatus, ParseUUIDPipe,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { InvoicesService } from './invoices.service';
import { CreateInvoiceDto, UpdateInvoiceDto, TransitionInvoiceDto, InvTransitionStatus, CreateInvoiceLineDto, UpdateInvoiceLineDto } from './invoices.dto';

@ApiTags('Invoices')
@Controller('invoices')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class InvoicesController {
  constructor(private readonly service: InvoicesService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Список рахунків' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'status', required: false })
  findAll(
    @OrgContext() orgId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('status') status?: string,
  ) {
    return this.service.findAll(orgId, +page, +limit, status);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Рахунок по ID' })
  findOne(@OrgContext() orgId: string, @Param('id') id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Створити рахунок вручну' })
  create(
    @OrgContext() orgId: string,
    @Body() dto: CreateInvoiceDto,
    @CurrentUser() user: { id: string },
  ) {
    // Bug #92: @CurrentUser повертає { id, orgId, role } (jwt.strategy.ts), не { sub }.
    // user.sub був завжди undefined → creator/audit info втрачено.
    return this.service.create(orgId, dto, user?.id);
  }

  @Post('from-work-order/:workOrderId')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Виставити рахунок з наряду' })
  createFromWorkOrder(
    @OrgContext() orgId: string,
    @Param('workOrderId') workOrderId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.createFromWorkOrder(orgId, workOrderId, user?.id);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Оновити рахунок (тільки DRAFT)' })
  update(
    @OrgContext() orgId: string,
    @Param('id') id: string,
    @Body() dto: UpdateInvoiceDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Post(':id/transition')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Змінити статус рахунку (FSM)' })
  transition(
    @OrgContext() orgId: string,
    @Param('id') id: string,
    @Body() dto: TransitionInvoiceDto,
  ) {
    return this.service.transition(orgId, id, dto.status as InvTransitionStatus);
  }

  @Post(':id/clone')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Дублювати рахунок' })
  clone(
    @OrgContext() orgId: string,
    @Param('id') id: string,
  ) {
    return this.service.clone(orgId, id);
  }

  @Get(':id/pdf')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Завантажити рахунок у PDF' })
  async downloadPdf(
    @OrgContext() orgId: string,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const buffer = await this.service.generatePdf(orgId, id);
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="invoice-${id}.pdf"`)
      .send(buffer);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити рахунок (тільки DRAFT)' })
  remove(@OrgContext() orgId: string, @Param('id') id: string) {
    return this.service.remove(orgId, id);
  }

  @Post(':id/lines')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Додати рядок до рахунку' })
  addLine(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateInvoiceLineDto,
  ) {
    return this.service.addLine(orgId, id, dto);
  }

  @Patch(':id/lines/:lineId')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Оновити рядок рахунку' })
  updateLine(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() dto: UpdateInvoiceLineDto,
  ) {
    return this.service.updateLine(orgId, id, lineId, dto);
  }

  @Delete(':id/lines/:lineId')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити рядок рахунку' })
  removeLine(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
  ) {
    return this.service.removeLine(orgId, id, lineId);
  }
}
