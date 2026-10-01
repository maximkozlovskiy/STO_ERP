import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

/** Статуси зарплатного періоду — єдине місце правди для валідації фільтра. */
export const PAYROLL_PERIOD_STATUSES = ['DRAFT', 'COMPUTED', 'PAID', 'CANCELLED'] as const;
export type PayrollPeriodStatus = (typeof PAYROLL_PERIOD_STATUSES)[number];

export class PayrollQueryDto {
  @ApiProperty({ example: '2026-09-01', description: 'Початок періоду (YYYY-MM-DD)' })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: '2026-09-30', description: 'Кінець періоду (YYYY-MM-DD)' })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional({ description: 'Фільтр по філії' })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

/** Список періодів: пагінація + фільтр статусу (список росте щомісяця — плоский список не тримає). */
export class PayrollPeriodListQueryDto {
  @ApiPropertyOptional({ enum: PAYROLL_PERIOD_STATUSES, description: 'Фільтр по статусу' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsIn(PAYROLL_PERIOD_STATUSES)
  status?: PayrollPeriodStatus;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  limit: number = 20;
}

/** Проведення виплати. cashRegisterId — якщо задано, ЗП видається готівкою з каси (cash-out). */
export class PayPayrollDto {
  @ApiPropertyOptional({ description: 'Каса для видачі готівкою (без неї — лише фіксація факту)' })
  @IsOptional()
  @IsUUID()
  cashRegisterId?: string;
}

export class CreatePayrollPeriodDto {
  @ApiProperty({ example: '2026-09-01' })
  @IsDateString()
  periodStart!: string;

  @ApiProperty({ example: '2026-09-30' })
  @IsDateString()
  periodEnd!: string;

  @ApiPropertyOptional({ description: 'Фільтр по філії (null = усі)' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ example: 'Вересень 2026' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

/**
 * Розшифровка нарахування по одному наряду (snapshot на момент COMPUTED).
 * baseAmount — Σ сума робіт цього наряду (частка бази). Нарахування рахується від СУМИ бази за
 * схемою оплати, тому по-нарядно не розкидається — показуємо лише базу й нормо-години.
 */
export class PayrollLineWorkOrderDto {
  @ApiProperty() workOrderId!: string;
  @ApiProperty({ example: 'WO-2026-0001' }) workOrderNumber!: string;
  @ApiPropertyOptional({ type: String, nullable: true, example: 'Toyota Camry · AA1234BB' })
  vehicleName?: string | null;
  @ApiProperty({ description: 'К-сть врахованих робіт наряду' }) worksCount!: number;
  @ApiProperty({ description: 'Σ нормо-годин по наряду' }) normoHours!: number;
  @ApiProperty({ description: 'Σ сума робіт наряду (частка бази)' }) baseAmount!: number;
}

/** Рядок нарахування у preview/period (співробітник + база + нараховано). */
export class PayrollLineDto {
  @ApiProperty() employeeId!: string;
  @ApiProperty() employeeName!: string;
  @ApiProperty({ description: 'percent_normo | per_normo_hour | fixed_plus_bonus' })
  rateSchemeType!: string;
  @ApiProperty({ description: 'Σ суми виконаних робіт (база для %)' }) baseAmount!: number;
  @ApiProperty({ description: 'Σ нормо-годин' }) normoHours!: number;
  @ApiProperty({ description: 'К-сть врахованих ліній нарядів' }) linesCount!: number;
  @ApiProperty({ description: 'Нараховано до виплати' }) accruedAmount!: number;
  @ApiPropertyOptional({ description: 'Фактично виплачено (лише у збереженому періоді)' })
  paidAmount?: number;
  @ApiPropertyOptional({
    type: [PayrollLineWorkOrderDto],
    description: 'Розшифровка по нарядах (лише у GET /payroll/periods/:id)',
  })
  workOrders?: PayrollLineWorkOrderDto[];
}

export class PayrollPreviewDto {
  @ApiProperty({ type: [PayrollLineDto] }) lines!: PayrollLineDto[];
  @ApiProperty({ description: 'Σ нарахувань' }) totalAccrued!: number;
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
}

export class PayrollPeriodResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) branchId?: string | null;
  @ApiProperty() periodStart!: string;
  @ApiProperty() periodEnd!: string;
  @ApiProperty({ description: 'DRAFT | COMPUTED | PAID | CANCELLED' }) status!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) note?: string | null;
  @ApiProperty({ description: 'Σ нарахувань по рядках' }) totalAccrued!: number;
  @ApiProperty({ description: 'Σ виплачено' }) totalPaid!: number;
  @ApiPropertyOptional({ type: [PayrollLineDto] }) lines?: PayrollLineDto[];
  @ApiPropertyOptional({ type: String, nullable: true }) computedAt?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) paidAt?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

/** Сторінка зарплатних періодів — контракт usePaginatedList (items/total/page/limit). */
export class PaginatedPayrollPeriodsDto {
  @ApiProperty({ type: [PayrollPeriodResponseDto] }) items!: PayrollPeriodResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
