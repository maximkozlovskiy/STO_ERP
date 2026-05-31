import { IsUUID, IsOptional, IsString, IsISO8601, IsEnum } from 'class-validator';
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
  @ApiProperty() startAt!: Date;
  @ApiProperty() endAt!: Date;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional() workOrderNumber?: string;
  @ApiPropertyOptional() counterpartyId?: string | null;
  @ApiPropertyOptional() counterpartyName?: string;
  @ApiProperty({ enum: CalendarSlotStatus }) status!: CalendarSlotStatus;
  @ApiProperty({ enum: CalendarSlotType }) type!: CalendarSlotType;
}
