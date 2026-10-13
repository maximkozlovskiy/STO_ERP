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
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { cashOperationSchema, type CashOperationFormValues } from '@sto/shared';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { CashRegistersService } from './cash-registers.service';
import { CreateCashRegisterDto, UpdateCashRegisterDto } from './cash-registers.dto';
import { CashService } from '../cash/cash.service';
import { CashDeskService, type CashDeskActor } from './cash-desk.service';
import { assertCalendarDateQuery } from '../../common/utils/date-query';
import { CashOperationResponseDto, CreateCashOperationDto } from '../cash/cash.dto';

@ApiTags('Каса')
@Controller('cash-registers')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class CashRegistersController {
  constructor(
    private readonly service: CashRegistersService,
    private readonly cash: CashService,
    private readonly desk: CashDeskService,
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
  @ApiOkResponse({ type: [CashOperationResponseDto] })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Примітка, стаття руху коштів або назва контрагента',
  })
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
    assertCalendarDateQuery(dateFrom, dateTo);
    return this.cash.listOperations(orgId, id, limit ? Number(limit) : undefined, {
      q,
      dateFrom,
      dateTo,
    });
  }

  // BR-CASH-021: приймальня допущена до маршруту, але лише з приводами зі свого переліку
  // (`RECEPTIONIST_CASH_REASONS`) — решту відсікає CashDeskService (403).
  @Post(':id/operations')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @UseInterceptors(IdempotencyInterceptor) // подвійний клік / повтор після обриву не дає двох оплат
  @ApiOperation({
    summary:
      'Касова операція: внести (IN) / видати (OUT) готівку; оплати й повернення змінюють борг контрагента',
  })
  @ApiBody({ type: CreateCashOperationDto })
  @ApiCreatedResponse({ type: CashOperationResponseDto })
  createOperation(
    @OrgContext() orgId: string,
    @CurrentUser() user: CashDeskActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(cashOperationSchema)) dto: CashOperationFormValues,
  ) {
    return this.desk.create(orgId, id, dto, user);
  }
}
