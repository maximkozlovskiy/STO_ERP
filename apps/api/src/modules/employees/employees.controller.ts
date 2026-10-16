import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import {
  employeeCreateSchema,
  employeeUpdateSchema,
  type EmployeeCreateValues,
  type EmployeeUpdateValues,
} from '@sto/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  AssignBranchesDto,
  AssignLiftsDto,
  AssignWorkCategoriesDto,
  AssignZonesDto,
  EmployeeResponseDto,
  EmployeesQueryDto,
} from './employees.dto';
import { EmployeesService } from './employees.service';

@ApiTags('Співробітники')
@Controller('employees')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class EmployeesController {
  constructor(private readonly service: EmployeesService) {}

  @Get()
  // ACCOUNTANT: пікер працівника в модалці рознесення виплати зарплати (BR-BANK-030).
  // MECHANIC: довідник механіків картки наряду (рішення власника 2026-10-16, employee.md).
  // Список не віддає rateScheme, тож розширення не відкриває ставок.
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT', 'MECHANIC')
  @ApiOperation({
    summary: 'Список співробітників',
    description: 'MECHANIC отримує лише механіків, без видалених — незалежно від `role`',
  })
  @ApiResponse({ status: 200, type: [EmployeeResponseDto] })
  findAll(
    @OrgContext() orgId: string,
    @Query() query: EmployeesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Механік читає лише довідник механіків (`?role=MECHANIC` картки наряду): інший `role` чи
    // `showDeleted` не розширюють йому список на власника, бухгалтера чи звільнених.
    const scoped: EmployeesQueryDto =
      user.role === 'MECHANIC'
        ? { ...query, role: UserRole.MECHANIC, showDeleted: undefined }
        : query;
    return this.service.findAll(orgId, scoped);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Картка співробітника' })
  @ApiResponse({
    status: 200,
    type: EmployeeResponseDto,
    description: 'rateScheme присутній лише для OWNER/ADMIN (EmployeeDetailDto)',
  })
  findOne(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): ReturnType<EmployeesService['findOne']> {
    const includeRateScheme = user.role === 'OWNER' || user.role === 'ADMIN';
    return this.service.findOne(orgId, id, includeRateScheme);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити співробітника' })
  @ApiResponse({ status: 201, type: EmployeeResponseDto })
  create(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(employeeCreateSchema)) dto: EmployeeCreateValues,
  ) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити співробітника' })
  @ApiResponse({ status: 200, type: EmployeeResponseDto })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(employeeUpdateSchema)) dto: EmployeeUpdateValues,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // BR-EMP-001: id поточного користувача — для запобіжника «не можна звільнити самого себе».
    return this.service.update(orgId, id, dto, user.id);
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
  assignZones(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignZonesDto,
  ) {
    return this.service.assignZones(orgId, id, dto);
  }

  @Post(':id/lifts')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Призначити підйомники співробітнику (замінює поточні)' })
  @ApiResponse({ status: 200, type: EmployeeResponseDto })
  assignLifts(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignLiftsDto,
  ) {
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
