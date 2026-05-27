import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import {
  AssignBranchesDto, AssignLiftsDto, AssignWorkCategoriesDto, AssignZonesDto,
  CreateEmployeeDto, EmployeeResponseDto, EmployeesQueryDto, UpdateEmployeeDto,
} from './employees.dto';
import { EmployeesService } from './employees.service';

@ApiTags('Співробітники')
@Controller('employees')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class EmployeesController {
  constructor(private readonly service: EmployeesService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Список співробітників' })
  @ApiResponse({ status: 200, type: [EmployeeResponseDto] })
  findAll(@OrgContext() orgId: string, @Query() query: EmployeesQueryDto) {
    return this.service.findAll(orgId, query);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Картка співробітника' })
  @ApiResponse({ status: 200, type: EmployeeResponseDto })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити співробітника' })
  @ApiResponse({ status: 201, type: EmployeeResponseDto })
  create(@OrgContext() orgId: string, @Body() dto: CreateEmployeeDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити співробітника' })
  @ApiResponse({ status: 200, type: EmployeeResponseDto })
  update(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateEmployeeDto) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити співробітника (soft delete)' })
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }

  @Post(':id/zones')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Призначити зони співробітнику (замінює поточні)' })
  @ApiResponse({ status: 200, type: EmployeeResponseDto })
  assignZones(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignZonesDto) {
    return this.service.assignZones(orgId, id, dto);
  }

  @Post(':id/lifts')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Призначити підйомники співробітнику (замінює поточні)' })
  @ApiResponse({ status: 200, type: EmployeeResponseDto })
  assignLifts(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignLiftsDto) {
    return this.service.assignLifts(orgId, id, dto);
  }

  @Post(':id/work-categories')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Призначити категорії робіт (замінює поточні)' })
  @ApiResponse({ status: 200, type: EmployeeResponseDto })
  assignWorkCategories(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignWorkCategoriesDto,
  ) {
    return this.service.assignWorkCategories(orgId, id, dto);
  }

  @Post(':id/branches')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Призначити філії співробітнику (замінює поточні)' })
  @ApiResponse({ status: 200, type: EmployeeResponseDto })
  assignBranches(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignBranchesDto,
  ) {
    return this.service.assignBranches(orgId, id, dto);
  }
}
