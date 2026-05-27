import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { UserRole } from '@prisma/client';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import {
  CreateMaintenanceScheduleDto, UpdateMaintenanceScheduleDto,
  MaintenanceScheduleResponseDto, UpcomingMaintenanceQueryDto,
} from './maintenance-schedules.dto';

@ApiTags('Maintenance Schedules')
@Controller('maintenance-schedules')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class MaintenanceSchedulesController {
  constructor(private readonly service: MaintenanceSchedulesService) {}

  @Get('upcoming')
  @Roles(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.OWNER)
  @ApiOperation({ summary: 'Vehicles with upcoming maintenance' })
  @ApiResponse({ status: 200, type: [MaintenanceScheduleResponseDto] })
  findUpcoming(@OrgContext() orgId: string, @Query() query: UpcomingMaintenanceQueryDto) {
    return this.service.findUpcoming(orgId, query.days);
  }

  @Get()
  @Roles(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.OWNER, UserRole.MECHANIC)
  @ApiOperation({ summary: 'List maintenance schedules' })
  @ApiResponse({ status: 200, type: [MaintenanceScheduleResponseDto] })
  findAll(@OrgContext() orgId: string, @Query('vehicleId', new ParseUUIDPipe({ optional: true })) vehicleId?: string) {
    return this.service.findAll(orgId, vehicleId);
  }

  @Get(':id')
  @Roles(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.OWNER, UserRole.MECHANIC)
  @ApiResponse({ status: 200, type: MaintenanceScheduleResponseDto })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.OWNER)
  @ApiResponse({ status: 201, type: MaintenanceScheduleResponseDto })
  create(@OrgContext() orgId: string, @Body() dto: CreateMaintenanceScheduleDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.OWNER)
  @ApiResponse({ status: 200, type: MaintenanceScheduleResponseDto })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMaintenanceScheduleDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN, UserRole.OWNER)
  @ApiOperation({ summary: 'Soft-delete maintenance schedule' })
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }
}
