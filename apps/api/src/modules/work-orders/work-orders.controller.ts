import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { WorkOrdersService } from './work-orders.service';
import {
  CreateWorkOrderDto,
  UpdateWorkOrderDto,
  TransitionWorkOrderDto,
  WorkOrderQueryDto,
  CreateWorkOrderLineDto,
  UpdateWorkOrderLineDto,
  CreateWorkOrderPartDto,
  UpdateWorkOrderPartDto,
  SendEstimateSmsDto,
  LinkedCountsDto,
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

  // ─── Linked Documents ─────────────────────────────────
  // Специфічні маршрути ПЕРЕД @Get(':id') — Fastify route ordering

  @Get(':id/linked-documents')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT')
  @ApiOperation({ summary: "Пов'язані документи наряду (рахунки, оплати, слоти, гарантії)" })
  getLinkedDocuments(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getLinkedDocuments(orgId, id);
  }

  @Post('linked-counts')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Кількість пов'язаних документів для списку нарядів (batch)" })
  getLinkedCounts(@OrgContext() orgId: string, @Body() dto: LinkedCountsDto) {
    return this.service.getLinkedCounts(orgId, dto.workOrderIds);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Деталі наряду' })
  findOne(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { role: string },
  ) {
    // §2.1 Auth: pass role → service маскує part.costPrice для MECHANIC/RECEPTIONIST
    return this.service.findOne(orgId, id, user.role);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Створити наряд' })
  create(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: CreateWorkOrderDto,
  ) {
    return this.service.create(orgId, dto, user.id);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Оновити наряд' })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkOrderDto,
    @CurrentUser() user: { id: string },
  ) {
    // Bug #86: pass user.id so update() writes a per-field AuditEvent.
    return this.service.update(orgId, id, dto, user.id);
  }

  @Get(':id/pdf')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Завантажити наряд у PDF' })
  async downloadPdf(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
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
  remove(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(orgId, id, user.id);
  }

  @Post(':id/transition')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Змінити статус наряду (FSM)' })
  transition(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionWorkOrderDto,
    @CurrentUser() user: { id: string },
  ) {
    // @CurrentUser повертає { id, orgId, role } (див. AuthenticatedUser у jwt.strategy.ts).
    // Раніше тут була анотація { sub } — `user.sub` був undefined у рантаймі,
    // через що audit-лог про FSM-перехід тихо не писався.
    return this.service.transition(orgId, id, dto.status, user.id);
  }

  @Post(':id/clone')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Дублювати наряд' })
  clone(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.clone(orgId, id, user.id);
  }

  // ─── Estimate Share ──────────────────────────────────────

  @Post(':id/share-token')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Отримати або створити share-токен для кошторису' })
  getShareToken(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getOrCreateShareToken(orgId, id);
  }

  @Post(':id/send-estimate-sms')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Надіслати кошторис клієнту через SMS' })
  sendEstimateSms(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    // baseUrl навмисно НЕ приймається з тіла — формується на сервері (open-redirect ризик).
    // DTO залишено порожнім + ValidationPipe whitelist=true → зайві поля 400.
    @Body() _dto: SendEstimateSmsDto,
  ) {
    return this.service.sendEstimateSms(orgId, id);
  }

  // ─── Lines ───────────────────────────────────────────────

  @Post(':id/lines')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Додати роботу до наряду' })
  addLine(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateWorkOrderLineDto,
  ) {
    return this.service.addLine(orgId, id, dto);
  }

  @Patch(':id/lines/:lineId')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Оновити рядок роботи' })
  updateLine(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() dto: UpdateWorkOrderLineDto,
  ) {
    return this.service.updateLine(orgId, id, lineId, dto);
  }

  @Delete(':id/lines/:lineId')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити рядок роботи' })
  removeLine(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
  ) {
    return this.service.removeLine(orgId, id, lineId);
  }

  // ─── Parts ───────────────────────────────────────────────

  @Post(':id/parts')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Додати запчастину до наряду' })
  addPart(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateWorkOrderPartDto,
    // Bug #529: симетрично з findOne — service маскує costPrice для не-привілейованих
    // ролей. Без role-передачі OWNER/ADMIN не побачив би costPrice одразу після
    // додавання (fail-closed default → undefined → refresh потрібен).
    @CurrentUser() user: { role: string },
  ) {
    return this.service.addPart(orgId, id, dto, user.role);
  }

  @Patch(':id/parts/:partId')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Оновити запчастину наряду' })
  updatePart(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('partId', ParseUUIDPipe) partId: string,
    @Body() dto: UpdateWorkOrderPartDto,
    @CurrentUser() user: { role: string },
  ) {
    return this.service.updatePart(orgId, id, partId, dto, user.role);
  }

  @Delete(':id/parts/:partId')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити запчастину наряду' })
  removePart(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('partId', ParseUUIDPipe) partId: string,
  ) {
    return this.service.removePart(orgId, id, partId);
  }
}
