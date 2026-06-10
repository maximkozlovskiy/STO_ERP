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
import { CalendarService } from './calendar.service';
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
  constructor(private readonly service: CalendarService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Слоти на дату' })
  @ApiQuery({ name: 'date', required: true, example: '2026-05-22' })
  @ApiQuery({ name: 'branchId', required: false })
  @ApiQuery({ name: 'employeeId', required: false })
  findSlots(
    @OrgContext() orgId: string,
    @Query('date') date: string,
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string,
    @Query('employeeId', new ParseUUIDPipe({ optional: true })) employeeId?: string,
  ) {
    return this.service.findSlots(orgId, date, branchId, employeeId);
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
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({
    summary: 'Створити слот (повертає 1 або 2 слоти якщо виходить за межі робочого дня)',
  })
  createSlot(
    @OrgContext() orgId: string,
    @Body() dto: CreateCalendarSlotDto,
  ): Promise<CreateCalendarSlotResponseDto> {
    return this.service.createSlot(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Оновити слот (час, підйомник, наряд)' })
  updateSlot(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCalendarSlotDto,
  ) {
    return this.service.updateSlot(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити слот' })
  removeSlot(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.removeSlot(orgId, id);
  }
}
