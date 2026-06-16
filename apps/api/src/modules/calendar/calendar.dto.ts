import { IsUUID, IsOptional, IsString, IsISO8601, IsEnum, IsDateString } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CalendarSlotStatus, CalendarSlotType } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class CreateCalendarSlotDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  liftId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  workOrderId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  counterpartyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  vehicleId?: string;

  @ApiProperty() @IsISO8601() startAt!: string;
  @ApiProperty() @IsISO8601() endAt!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  // Bug #261: emptyToUndefined gap — sprint cycle 3 покрив тільки UUID-поля,
  // enum-поля calendar лишилися без трансформу. Default selectstate `''` → 400.
  @ApiPropertyOptional({ enum: CalendarSlotStatus })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(CalendarSlotStatus)
  status?: CalendarSlotStatus;

  @ApiPropertyOptional({ enum: CalendarSlotType })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(CalendarSlotType)
  type?: CalendarSlotType;
}

export class UpdateCalendarSlotDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  liftId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  employeeId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  workOrderId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  counterpartyId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  vehicleId?: string | null;

  // Bug #261: emptyToUndefined gap у PATCH calendar slot — partial-update з порожнім рядком → 400.
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsISO8601()
  startAt?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsISO8601()
  endAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class CalendarSlotResponseDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() liftId?: string | null;
  @ApiPropertyOptional() employeeId?: string | null;
  @ApiPropertyOptional() workOrderId?: string | null;
  @ApiPropertyOptional() vehicleId?: string | null;
  @ApiPropertyOptional() parentSlotId?: string | null;
  @ApiProperty() startAt!: Date;
  @ApiProperty() endAt!: Date;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional() workOrderNumber?: string;
  @ApiPropertyOptional() workOrderStatus?: string | null;
  @ApiPropertyOptional() counterpartyId?: string | null;
  @ApiPropertyOptional() counterpartyName?: string;
  @ApiPropertyOptional() cpPhone?: string | null;
  @ApiPropertyOptional() vehicleSummary?: string | null;
  @ApiPropertyOptional() vehiclePlate?: string | null;
  @ApiProperty({ enum: CalendarSlotStatus }) status!: CalendarSlotStatus;
  @ApiProperty({ enum: CalendarSlotType }) type!: CalendarSlotType;
}

export class CreateCalendarSlotResponseDto {
  @ApiProperty({ type: [CalendarSlotResponseDto] })
  slots!: CalendarSlotResponseDto[];
}

export class CheckConflictsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  liftId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  excludeSlotId?: string;

  // Bug #397: при перевірці конфлікту з модалки наряду треба ігнорувати слоти
  // цього самого наряду — інакше будь-який редагований наряд що вже має слот
  // конфліктує сам із собою. excludeSlotId не підходить — наряд може мати кілька
  // слотів (split-across-days). Тому фільтруємо за workOrderId.
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  excludeWorkOrderId?: string;

  @ApiProperty() @IsDateString() startAt!: string;
  @ApiProperty() @IsDateString() endAt!: string;
}

export class SyncWorkOrderSlotsDto {
  @ApiProperty({ description: 'Новий startAt для всіх слотів наряду' })
  @IsISO8601()
  startAt!: string;

  @ApiProperty({ description: 'Новий endAt для всіх слотів наряду' })
  @IsISO8601()
  endAt!: string;
}

export class SyncWorkOrderSlotsResponseDto {
  @ApiProperty() updated!: number;
}

export class CheckConflictsResponseDto {
  @ApiProperty() liftConflict!: boolean;
  @ApiProperty() employeeConflict!: boolean;
  @ApiProperty() anyConflict!: boolean;
  @ApiProperty({ type: [CalendarSlotResponseDto] }) conflictSlots!: CalendarSlotResponseDto[];
}
