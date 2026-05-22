import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CreateWarehouseDto, UpdateWarehouseDto, WarehouseResponseDto } from './warehouses.dto';
import { WarehousesService } from './warehouses.service';

@ApiTags('Склади')
@Controller('warehouses')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class WarehousesController {
  constructor(private readonly service: WarehousesService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'STOREKEEPER')
  @ApiOperation({ summary: 'Список складів' })
  @ApiQuery({ name: 'branchId', required: false })
  @ApiResponse({ status: 200, type: [WarehouseResponseDto] })
  findAll(@OrgContext() orgId: string, @Query('branchId') branchId?: string) {
    return this.service.findAll(orgId, branchId);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  findOne(@OrgContext() orgId: string, @Param('id') id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити склад' })
  @ApiResponse({ status: 201, type: WarehouseResponseDto })
  create(@OrgContext() orgId: string, @Body() dto: CreateWarehouseDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  update(@OrgContext() orgId: string, @Param('id') id: string, @Body() dto: UpdateWarehouseDto) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@OrgContext() orgId: string, @Param('id') id: string) {
    return this.service.remove(orgId, id);
  }
}
