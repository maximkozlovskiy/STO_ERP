import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  Matches,
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
import { CALENDAR_DATE_RE } from '../../common/utils/kyiv-date';
import type { RateParams } from './payroll.calculator';

/** Статуси зарплатного періоду — єдине місце правди для валідації фільтра. */
export const PAYROLL_PERIOD_STATUSES = ['DRAFT', 'COMPUTED', 'PAID', 'CANCELLED'] as const;
export type PayrollPeriodStatus = (typeof PAYROLL_PERIOD_STATUSES)[number];

export class PayrollQueryDto {
  @ApiProperty({ example: '2026-09-01', description: 'Початок періоду (YYYY-MM-DD)' })
  @Matches(CALENDAR_DATE_RE)
  @IsDateString({ strict: true })
  from!: string;

  @ApiProperty({ example: '2026-09-30', description: 'Кінець періоду (YYYY-MM-DD)' })
  @Matches(CALENDAR_DATE_RE)
  @IsDateString({ strict: true })
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
  @Matches(CALENDAR_DATE_RE)
  @IsDateString({ strict: true })
  periodStart!: string;

  @ApiProperty({ example: '2026-09-30' })
  @Matches(CALENDAR_DATE_RE)
  @IsDateString({ strict: true })
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
 * baseAmount — Σ сума робіт цього наряду (частка бази). accruedAmount — частка змінної частини
 * нарахування рядка (BR-PAYR-016), обчислюється при читанні з бази наряду й нарахування рядка.
 */
export class PayrollLineWorkOrderDto {
  @ApiProperty() workOrderId!: string;
  @ApiProperty({ example: 'WO-2026-0001' }) workOrderNumber!: string;
  @ApiPropertyOptional({ type: String, nullable: true, example: 'Toyota Camry · AA1234BB' })
  vehicleName?: string | null;
  @ApiProperty({ description: 'К-сть врахованих робіт наряду' }) worksCount!: number;
  @ApiProperty({ description: 'Σ нормо-годин по наряду' }) normoHours!: number;
  @ApiProperty({ description: 'Σ сума робіт наряду (частка бази)' }) baseAmount!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Нараховано по наряду — частка змінної частини рядка (BR-PAYR-016); null — «оклад + бонус» ' +
      'без знімка умов (розклад невідомий)',
  })
  accruedAmount!: number | null;
}

/**
 * Умови схеми рядка (BR-PAYR-016): `{ percent }` | `{ ratePerHour }` | `{ fixedMonthly, bonusPercent }`
 * залежно від `rateSchemeType`.
 */
export class PayrollRateParamsDto {
  @ApiPropertyOptional({ description: '% від суми робіт (percent_normo)' }) percent?: number;
  @ApiPropertyOptional({ description: 'Ставка за нормо-годину, ₴ (per_normo_hour)' })
  ratePerHour?: number;
  @ApiPropertyOptional({ description: 'Місячний оклад, ₴ (fixed_plus_bonus)' })
  fixedMonthly?: number;
  @ApiPropertyOptional({ description: 'Бонус, % від суми робіт (fixed_plus_bonus)' })
  bonusPercent?: number;
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
  @ApiProperty({
    type: PayrollRateParamsDto,
    nullable: true,
    description:
      'Умови схеми: знімок на момент розрахунку або (rateDerived) виведені з підсумку; null — невідомі',
  })
  rateParams!: RateParams | null;
  @ApiProperty({
    description: 'Умови виведено з нарахування (рядок розраховано до знімка умов) — «≈» у вікні',
  })
  rateDerived!: boolean;
  @ApiPropertyOptional({
    description: 'Оклад за період («оклад + бонус», BR-PAYR-016) — окремий рядок розшифровки',
  })
  fixedPart?: number;
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
