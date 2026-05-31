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
  Header,
} from '@nestjs/common';
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

  @Header('Cache-Control', 'private, max-age=300, stale-while-revalidate=60')
  @Get()
  // MECHANIC needs read-only access — work order /parts modal renders a
  // warehouse <Select> and MECHANIC is permitted to add parts via
  // WorkOrdersController.@Roles('...','MECHANIC').
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'STOREKEEPER', 'MECHANIC')
  @ApiOperation({ summary: 'Список складів' })
  @ApiQuery({ name: 'branchId', required: false })
  @ApiResponse({ status: 200, type: [WarehouseResponseDto] })
  findAll(
    @OrgContext() orgId: string,
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string,
  ) {
    return this.service.findAll(orgId, branchId);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Отримати склад' })
  @ApiResponse({ status: 200, type: WarehouseResponseDto })
  @ApiResponse({ status: 404, description: 'Склад не знайдено' })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
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
  @ApiOperation({ summary: 'Оновити склад' })
  @ApiResponse({ status: 200, type: WarehouseResponseDto })
  @ApiResponse({ status: 404, description: 'Склад не знайдено' })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWarehouseDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити склад (soft delete)' })
  @ApiResponse({ status: 204, description: 'Склад видалено' })
  @ApiResponse({ status: 404, description: 'Склад не знайдено' })
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }
}
