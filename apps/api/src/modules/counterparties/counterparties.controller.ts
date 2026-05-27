import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import {
  CounterpartyQueryDto, CounterpartyResponseDto, CreateCounterpartyDto,
  CreateGarageDto, GarageResponseDto, PaginatedCounterpartiesDto, UpdateCounterpartyDto,
} from './counterparties.dto';
import { CounterpartiesService } from './counterparties.service';

@ApiTags('Контрагенти')
@Controller('counterparties')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class CounterpartiesController {
  constructor(private readonly service: CounterpartiesService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Список контрагентів з пошуком' })
  @ApiResponse({ status: 200, type: PaginatedCounterpartiesDto })
  findAll(@OrgContext() orgId: string, @Query() query: CounterpartyQueryDto) {
    return this.service.findAll(orgId, query);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT')
  @ApiResponse({ status: 200, type: CounterpartyResponseDto })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Створити контрагента (автоматично створює розрахунковий рахунок)' })
  @ApiResponse({ status: 201, type: CounterpartyResponseDto })
  create(@OrgContext() orgId: string, @Body() dto: CreateCounterpartyDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  update(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCounterpartyDto) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }

  // ─── Garages ─────────────────────────────────────────────

  @Get(':id/garages')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Гаражі контрагента' })
  @ApiResponse({ status: 200, type: [GarageResponseDto] })
  findGarages(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findGarages(orgId, id);
  }

  @Post(':id/garages')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Додати гараж' })
  @ApiResponse({ status: 201, type: GarageResponseDto })
  createGarage(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateGarageDto) {
    return this.service.createGarage(orgId, id, dto);
  }

  @Delete(':id/garages/:garageId')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeGarage(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string, @Param('garageId', ParseUUIDPipe) garageId: string) {
    return this.service.removeGarage(orgId, id, garageId);
  }
}
