import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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
