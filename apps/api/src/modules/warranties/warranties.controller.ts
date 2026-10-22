import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { WARRANTY_EXPIRING_DAYS } from '@sto/shared';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { WarrantiesService } from './warranties.service';
import {
  CreateWarrantyDto,
  ClaimWarrantyDto,
  WarrantyListQueryDto,
  PaginatedWarrantiesDto,
} from './warranties.dto';

@ApiTags('warranties')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('warranties')
export class WarrantiesController {
  constructor(private readonly service: WarrantiesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Створити гарантію' })
  create(@Body() dto: CreateWarrantyDto, @CurrentUser() user: { id: string; orgId: string }) {
    return this.service.create(user.orgId, dto);
  }

  // Корінь `GET /warranties` не перетинається з `expiring`, `by-counterparty/:id`,
  // `by-work-order/:id` (інший шлях), але стоїть після них — за правилом «специфічні першими».
  @Get('expiring')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Гарантії що закінчуються' })
  findExpiring(
    @Query('days') days: string = String(WARRANTY_EXPIRING_DAYS),
    @CurrentUser() user: { id: string; orgId: string },
  ) {
    return this.service.findExpiring(
      user.orgId,
      Math.min(Number(days) || WARRANTY_EXPIRING_DAYS, 365),
    );
  }

  @Get('by-counterparty/:counterpartyId')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Гарантії контрагента' })
  findByCounterparty(
    @Param('counterpartyId', ParseUUIDPipe) counterpartyId: string,
    @CurrentUser() user: { id: string; orgId: string },
  ) {
    return this.service.findByCounterparty(user.orgId, counterpartyId);
  }

  @Get('by-work-order/:workOrderId')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Гарантії наряду' })
  findByWorkOrder(
    @Param('workOrderId', ParseUUIDPipe) workOrderId: string,
    @CurrentUser() user: { id: string; orgId: string },
  ) {
    return this.service.findByWorkOrder(user.orgId, workOrderId);
  }

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Список гарантій (вкладка «Гарантії» нарядів)' })
  @ApiOkResponse({ type: PaginatedWarrantiesDto })
  findAll(@Query() query: WarrantyListQueryDto, @CurrentUser() user: { orgId: string }) {
    return this.service.findAll(user.orgId, query);
  }

  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: "Пред'явити гарантійну претензію" })
  claim(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ClaimWarrantyDto,
    @CurrentUser() user: { id: string; orgId: string },
  ) {
    return this.service.claim(user.orgId, id, dto);
  }
}
