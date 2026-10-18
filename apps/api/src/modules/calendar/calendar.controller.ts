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
  SyncWorkOrderSlotsDto,
  SyncWorkOrderSlotsResponseDto,
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
  })
  createSlot(
    @OrgContext() orgId: string,
    @Body() dto: CreateCalendarSlotDto,
  ): Promise<CreateCalendarSlotResponseDto> {
    return this.service.createSlot(orgId, dto);
  }

  @Patch('by-work-order/:workOrderId')
  @Roles(...CALENDAR_WRITE_ROLES)
  @ApiOperation({
    summary: 'Перенести запис наряду на нові дати — через дати наряду',
    description:
      'startAt/endAt стають плановими початком і завершенням наряду (як PATCH /work-orders/:id, ' +
      'BR-WO-019, BR-WO-020); відмова — 400 без змін (BR-WO-024). Web не викликає',
  })
  @ApiResponse({ status: 200, type: SyncWorkOrderSlotsResponseDto })
  syncWorkOrderSlots(
    @OrgContext() orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('workOrderId', ParseUUIDPipe) workOrderId: string,
    @Body() dto: SyncWorkOrderSlotsDto,
  ): Promise<SyncWorkOrderSlotsResponseDto> {
    return this.workOrders.moveCalendarByDates(orgId, workOrderId, dto, user.id);
  }

  @Patch(':id')
  @Roles(...CALENDAR_WRITE_ROLES)
  @ApiOperation({
    summary: 'Оновити слот (час, підйомник, наряд)',
    description:
      'Час чи підйомник запису наряду змінюють наряд: межі ланцюжка запису стають плановими ' +
      'датами наряду, підйомник — підйомником наряду, перевірки як у PATCH /work-orders/:id; ' +
      'відмова — 400 без змін (BR-WO-024)',
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
  @ApiOperation({ summary: 'Видалити слот' })
  removeSlot(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.removeSlot(orgId, id);
  }
}
