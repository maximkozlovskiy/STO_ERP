import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PayrollService } from './payroll.service';
import {
  CreatePayrollPeriodDto,
  PayPayrollDto,
  PayrollPeriodResponseDto,
  PayrollPreviewDto,
  PayrollQueryDto,
} from './payroll.dto';

@ApiTags('Зарплата')
@Controller('payroll')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class PayrollController {
  constructor(private readonly service: PayrollService) {}

  @Get('preview')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Попередній розрахунок нарахувань за період (без збереження)' })
  @ApiResponse({ status: 200, type: PayrollPreviewDto })
  preview(@OrgContext() orgId: string, @Query() query: PayrollQueryDto) {
    return this.service.preview(orgId, query.from, query.to, query.branchId);
  }

  @Get('periods')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Список зарплатних періодів' })
  @ApiResponse({ status: 200, type: [PayrollPeriodResponseDto] })
  findAll(@OrgContext() orgId: string) {
    return this.service.findAll(orgId);
  }

  @Get('periods/:id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiResponse({ status: 200, type: PayrollPeriodResponseDto })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post('periods')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Створити зарплатний період (DRAFT)' })
  @ApiResponse({ status: 201, type: PayrollPeriodResponseDto })
  create(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: CreatePayrollPeriodDto,
  ) {
    return this.service.create(orgId, dto, user?.id);
  }

  @Post('periods/:id/compute')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Розрахувати нарахування (DRAFT → COMPUTED)' })
  @ApiResponse({ status: 200, type: PayrollPeriodResponseDto })
  compute(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.compute(orgId, id, user?.id);
  }

  @Post('periods/:id/pay')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Провести виплату (COMPUTED → PAID)' })
  @ApiResponse({ status: 200, type: PayrollPeriodResponseDto })
  pay(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayPayrollDto,
  ) {
    return this.service.pay(orgId, id, user?.id, dto?.cashRegisterId);
  }

  @Delete('periods/:id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити період (окрім виплаченого)' })
  remove(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(orgId, id, user?.id);
  }
}
