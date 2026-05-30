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
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import {
  CreateVehicleDto,
  CreateVehicleNodeDto,
  UpdateVehicleDto,
  VehicleNodeResponseDto,
  VehicleResponseDto,
} from './vehicles.dto';
import { VehiclesService } from './vehicles.service';

@ApiTags('Автомобілі')
@Controller('vehicles')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class VehiclesController {
  constructor(private readonly service: VehiclesService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Список авто' })
  @ApiQuery({ name: 'customerGarageId', required: false })
  @ApiResponse({ status: 200, type: [VehicleResponseDto] })
  findAll(
    @OrgContext() orgId: string,
    @Query('customerGarageId', new ParseUUIDPipe({ optional: true })) garageId?: string,
  ) {
    return this.service.findAll(orgId, garageId);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Додати авто' })
  @ApiResponse({ status: 201, type: VehicleResponseDto })
  create(@OrgContext() orgId: string, @Body() dto: CreateVehicleDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVehicleDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }

  @Get(':id/nodes')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Вузли автомобіля' })
  @ApiResponse({ status: 200, type: [VehicleNodeResponseDto] })
  findNodes(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findNodes(orgId, id);
  }

  @Post(':id/nodes')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Додати вузол' })
  @ApiResponse({ status: 201, type: VehicleNodeResponseDto })
  createNode(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateVehicleNodeDto,
  ) {
    return this.service.createNode(orgId, id, dto);
  }

  @Delete(':id/nodes/:nodeId')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeNode(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ) {
    return this.service.removeNode(orgId, id, nodeId);
  }
}
