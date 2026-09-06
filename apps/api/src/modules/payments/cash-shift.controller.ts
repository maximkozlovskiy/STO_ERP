import { Controller, Get, Post, Param, Query, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { CashShiftService } from './cash-shift.service';

@ApiTags('Cash Shifts')
@Controller('cash-shifts')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class CashShiftController {
  constructor(private readonly service: CashShiftService) {}

  @Get('current')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Поточна відкрита зміна філії (або null)' })
  @ApiQuery({ name: 'branchId', required: true })
  getCurrent(@OrgContext() orgId: string, @Query('branchId', ParseUUIDPipe) branchId: string) {
    return this.service.getCurrent(orgId, branchId);
  }

  // open/close роблять зовнішній Checkbox-виклик — тротлимо.
  @Post('open')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Відкрити касову зміну (PIN→token→Checkbox)' })
  @ApiQuery({ name: 'branchId', required: true })
  open(
    @OrgContext() orgId: string,
    @Query('branchId', ParseUUIDPipe) branchId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.open(orgId, branchId, user?.id);
  }

  @Post(':id/close')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Закрити зміну (Z-звіт)' })
  close(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.close(orgId, id, user?.id);
  }
}
