import {
  BadRequestException,
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
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { CashRegistersService } from './cash-registers.service';
import { CreateCashRegisterDto, UpdateCashRegisterDto } from './cash-registers.dto';
import { CashService } from '../cash/cash.service';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { isCalendarDate } from '../../common/utils/kyiv-date';
import { CreateCashOperationDto } from '../cash/cash.dto';

@ApiTags('Каса')
@Controller('cash-registers')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class CashRegistersController {
  constructor(
    private readonly service: CashRegistersService,
    private readonly cash: CashService,
  ) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Список кас' })
  @ApiQuery({ name: 'branchId', required: false })
  findAll(
    @OrgContext() orgId: string,
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string,
  ) {
    return this.service.findAll(orgId, branchId);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Каса' })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити касу' })
  create(@OrgContext() orgId: string, @Body() dto: CreateCashRegisterDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити касу' })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCashRegisterDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити касу (soft delete)' })
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }

  // ─── Рух готівки (операції) ───────────────────────────────────────────────

  @Get(':id/balance')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Поточний залишок каси' })
  async balance(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return { balance: await this.cash.getBalance(orgId, id) };
  }

  @Get(':id/operations')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Історія касових операцій' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Максимум рядків (за замовчуванням 100)',
  })
  @ApiQuery({ name: 'q', required: false, description: 'Примітка або стаття витрат' })
  @ApiQuery({
    name: 'dateFrom',
    required: false,
    description: 'Київський день операції від (YYYY-MM-DD), включно',
  })
  @ApiQuery({
    name: 'dateTo',
    required: false,
    description: 'Київський день операції до (YYYY-MM-DD), включно',
  })
  operations(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    // Query-параметри без DTO → дату перевіряємо тут. Сміття дало б Invalid Date і безіменний
    // 400 від Prisma, а 31.02 `new Date` мовчки перекочує в березень — відбір за іншим днем.
    for (const value of [dateFrom, dateTo]) {
      if (value && !isCalendarDate(value))
        throw new BadRequestException(translateError('err.cash.invalidDateFilter', getLocale()));
    }
    return this.cash.listOperations(orgId, id, limit ? Number(limit) : undefined, {
      q,
      dateFrom,
      dateTo,
    });
  }

  @Post(':id/operations')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Ручна операція: внести (IN) / видати (OUT) готівку' })
  createOperation(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCashOperationDto,
  ) {
    return this.cash.createManual(orgId, id, dto, user?.id);
  }
}
