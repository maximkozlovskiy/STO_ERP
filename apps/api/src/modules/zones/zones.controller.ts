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
import {
  CreateLiftDto,
  CreateZoneDto,
  LiftResponseDto,
  UpdateLiftDto,
  UpdateZoneDto,
  ZoneResponseDto,
} from './zones.dto';
import { ZonesService } from './zones.service';

@ApiTags('Зони')
@Controller('zones')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ZonesController {
  constructor(private readonly service: ZonesService) {}

  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=60')
  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Список зон' })
  @ApiQuery({ name: 'branchId', required: false })
  @ApiResponse({ status: 200, type: [ZoneResponseDto] })
  findAll(
    @OrgContext() orgId: string,
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string,
  ) {
    return this.service.findAllZones(orgId, branchId);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOneZone(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити зону' })
  @ApiResponse({ status: 201, type: ZoneResponseDto })
  create(@OrgContext() orgId: string, @Body() dto: CreateZoneDto) {
    return this.service.createZone(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateZoneDto,
  ) {
    return this.service.updateZone(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.removeZone(orgId, id);
  }
}

@ApiTags('Підйомники')
@Controller('lifts')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class LiftsController {
  constructor(private readonly service: ZonesService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Список підйомників' })
  @ApiQuery({ name: 'zoneId', required: false })
  @ApiResponse({ status: 200, type: [LiftResponseDto] })
  findAll(
    @OrgContext() orgId: string,
    @Query('zoneId', new ParseUUIDPipe({ optional: true })) zoneId?: string,
  ) {
    return this.service.findAllLifts(orgId, zoneId);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOneLift(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити підйомник' })
  @ApiResponse({ status: 201, type: LiftResponseDto })
  create(@OrgContext() orgId: string, @Body() dto: CreateLiftDto) {
    return this.service.createLift(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLiftDto,
  ) {
    return this.service.updateLift(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.removeLift(orgId, id);
  }
}
