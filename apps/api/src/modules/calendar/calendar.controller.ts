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
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { CalendarService } from './calendar.service';
import { WorkOrdersService } from '../work-orders/work-orders.service';
import { CALENDAR_WRITE_ROLES } from './calendar-mechanic';
import {
  CreateCalendarSlotDto,
  UpdateCalendarSlotDto,
  CreateCalendarSlotResponseDto,
  CheckConflictsDto,
  CheckConflictsResponseDto,
} from './calendar.dto';

@ApiTags('Calendar')
@Controller('calendar/slots')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class CalendarController {
  constructor(
    private readonly service: CalendarService,
    // BR-WO-024: зміна часу чи підйомника запису наряду проходить через наряд.
    private readonly workOrders: WorkOrdersService,
  ) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Слоти на дату' })
  @ApiQuery({ name: 'date', required: true, example: '2026-05-22' })
  @ApiQuery({ name: 'branchId', required: false })
  @ApiQuery({ name: 'employeeId', required: false })
  findSlots(
    @OrgContext() orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('date') date: string,
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string,
    @Query('employeeId', new ParseUUIDPipe({ optional: true })) employeeId?: string,
  ) {
    return this.service.findSlots(orgId, date, user.role, branchId, employeeId);
  }

  @Post('check-conflicts')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Перевірити конфлікти слотів по підйомнику / механіку (read-only)' })
  @ApiResponse({ status: 200, type: CheckConflictsResponseDto })
  checkConflicts(
    @OrgContext() orgId: string,
    @Body() dto: CheckConflictsDto,
  ): Promise<CheckConflictsResponseDto> {
    return this.service.checkConflicts(orgId, dto);
  }

  @Post()
  @Roles(...CALENDAR_WRITE_ROLES)
  @ApiOperation({
    summary: 'Створити слот (повертає 1 або 2 слоти якщо виходить за межі робочого дня)',
    description:
      'З workOrderId — запис наряду (BR-WO-028): наряд із плановими датами — запис на його датах і ' +
      'підйомнику (один запис на наряд), без дат — час і підйомник запису стають датами наряду; ' +
      'лише в статусах «Чернетка», «Кошторис», «Затверджено» (BR-WO-027). Відповідь — записи наряду',
  })
  createSlot(
    @OrgContext() orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCalendarSlotDto,
  ): Promise<CreateCalendarSlotResponseDto> {
    return this.workOrders.createCalendarSlot(orgId, dto, user.id);
  }

  @Patch(':id')
  @Roles(...CALENDAR_WRITE_ROLES)
  @ApiOperation({
    summary: 'Оновити слот (час, підйомник, наряд)',
    description:
      'Час чи підйомник запису наряду змінюють наряд: межі ланцюжка запису стають плановими ' +
      'датами наряду, підйомник — підйомником наряду, перевірки як у PATCH /work-orders/:id; ' +
      'відмова — 400 без змін (BR-WO-024); лише в статусах «Чернетка», «Кошторис», ' +
      "«Затверджено» (BR-WO-027). Інший workOrderId — перев'язка: запис стає на дати нового " +
      'наряду (чи дає йому свої), попередній наряд утрачає дати (BR-WO-028)',
  })
  updateSlot(
    @OrgContext() orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCalendarSlotDto,
  ) {
    return this.workOrders.updateCalendarSlot(orgId, id, dto, user.id);
  }

  @Delete(':id')
  @Roles(...CALENDAR_WRITE_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Видалити слот',
    description:
      'Запис наряду: позначається видаленим увесь ланцюжок записів наряду, планові дати наряду ' +
      'стираються (нормогодини, виведені з дат, — теж; BR-WO-026)',
  })
  removeSlot(
    @OrgContext() orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.workOrders.removeCalendarSlot(orgId, id, user.id);
  }
}
