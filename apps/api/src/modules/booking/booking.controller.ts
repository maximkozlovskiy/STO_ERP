import {
  Controller, Get, Post, Patch, Delete, Param, Body,
  Query, UseGuards, HttpCode, HttpStatus, ParseUUIDPipe,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { BookingService } from './booking.service';
import { CreateBookingRequestDto } from './booking.dto';

@ApiTags('booking')
@Controller('booking')
export class BookingController {
  constructor(private readonly service: BookingService) {}

  // ─── Public endpoints (no auth required) ─────────────────

  @Get('availability')
  @ApiOperation({ summary: 'Вільні слоти для запису (публічний)' })
  async getAvailability(
    @Query('date') date: string,
    @Query('branchId') branchId: string,
    @Query('serviceIds') serviceIds?: string,
  ) {
    const branch = await this.service['prisma'].garageBranch.findFirst({ where: { id: branchId } });
    if (!branch) return [];
    return this.service.getAvailability(
      branch.orgId,
      branchId,
      date,
      serviceIds?.split(',').filter(Boolean),
    );
  }

  @Post('request')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Створити заявку на запис (публічний)' })
  async createPublic(@Body() dto: CreateBookingRequestDto) {
    const branch = await this.service['prisma'].garageBranch.findFirst({ where: { id: dto.branchId } });
    if (!branch) throw new NotFoundException('Філію не знайдено');
    return this.service.create(branch.orgId, dto);
  }

  // ─── Auth-protected endpoints ────────────────────────────

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Список заявок на запис' })
  findAll(@CurrentUser() user: { orgId: string }) {
    return this.service.findAll(user.orgId);
  }

  @Patch(':id/confirm')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Підтвердити заявку' })
  confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { orgId: string },
  ) {
    return this.service.confirm(user.orgId, id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Скасувати заявку' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { orgId: string },
  ) {
    return this.service.cancel(user.orgId, id);
  }
}
