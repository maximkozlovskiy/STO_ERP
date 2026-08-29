import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UUID_REGEX } from '@sto/shared';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { BookingService } from './booking.service';
import { CreateBookingRequestDto } from './booking.dto';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

@ApiTags('booking')
@Controller('booking')
export class BookingController {
  constructor(private readonly service: BookingService) {}

  // ─── Public endpoints (no auth required) ─────────────────

  /**
   * Public booking widget can't reach `/branches` (auth-guarded) —
   * provide a no-auth list endpoint that only exposes minimal fields.
   */
  @Get('branches')
  // Public endpoint → throttle to prevent enumeration / abuse of branch list.
  // 30 req/min per IP is plenty for legitimate widget usage (typically 1 call per page load).
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: 'Список філій для онлайн-запису (публічний)' })
  async listPublicBranches() {
    const branches = await this.service.listBranchesForBooking();
    // Drop orgId from public response — caller doesn't need it (server resolves
    // it via service.findBranchForBooking when needed).
    return branches.map(b => ({ id: b.id, name: b.name, address: b.address }));
  }

  @Get('availability')
  // Public endpoint → throttle slot enumeration (без cap зловмисник може
  // probing-ити доступність хвилину за хвилиною й мапити графік СТО).
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: 'Вільні слоти для запису (публічний)' })
  async getAvailability(
    @Query('date') date: string,
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId: string,
    @Query('serviceIds') serviceIds?: string,
  ) {
    // Lightweight runtime validation — avoid Prisma P2023 → 500 on bad UUID/date
    if (!branchId || !UUID_REGEX.test(branchId)) {
      throw new BadRequestException('Некоректний branchId');
    }
    if (!date || !DATE_RE.test(date)) {
      throw new BadRequestException('Дата у форматі YYYY-MM-DD');
    }
    // Soft-deleted branches must be invisible to public booking.
    const branch = await this.service.findBranchForBooking(branchId);
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
  // Public endpoint → strict throttle: 5 заявок/хв з одного IP блокує спам-флуд
  // (SMS уведомлення власнику СТО триггерять gateway-кошти).
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Створити заявку на запис (публічний)' })
  async createPublic(@Body() dto: CreateBookingRequestDto) {
    // Soft-deleted branches must be invisible to public booking.
    const branch = await this.service.findBranchForBooking(dto.branchId);
    if (!branch) throw new NotFoundException('Філію не знайдено');
    return this.service.create(branch.orgId, dto);
  }

  // ─── Auth-protected endpoints ────────────────────────────

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Список заявок на запис' })
  findAll(
    @CurrentUser() user: { orgId: string },
    @Query('date') date?: string,
    @Query('status') status?: string,
  ) {
    return this.service.findAll(user.orgId, { date, status });
  }

  @Patch(':id/confirm')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Підтвердити заявку' })
  confirm(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { orgId: string }) {
    return this.service.confirm(user.orgId, id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Скасувати заявку' })
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { orgId: string }) {
    return this.service.cancel(user.orgId, id);
  }
}
