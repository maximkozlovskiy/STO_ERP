import {
  IsUUID,
  Matches,
  IsOptional,
  IsString,
  IsISO8601,
  IsEnum,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CalendarSlotStatus, CalendarSlotType } from '@prisma/client';

export class CreateCalendarSlotDto {
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf(o => o.liftId != null)
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  liftId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf(o => o.employeeId != null)
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  employeeId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf(o => o.workOrderId != null)
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  workOrderId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf(o => o.counterpartyId != null)
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  counterpartyId?: string;
  @ApiProperty() @IsISO8601() startAt!: string;
  @ApiProperty() @IsISO8601() endAt!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional({ enum: CalendarSlotStatus })
  @IsOptional()
  @IsEnum(CalendarSlotStatus)
  status?: CalendarSlotStatus;
  @ApiPropertyOptional({ enum: CalendarSlotType })
  @IsOptional()
  @IsEnum(CalendarSlotType)
  type?: CalendarSlotType;
}

export class UpdateCalendarSlotDto {
  // ValidateIf(o => o.liftId !== null) — пропускає null (переміщення без підйомника),
  // @IsOptional — пропускає undefined (поле не передане взагалі).
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf(o => o.liftId !== null)
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  liftId?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf(o => o.employeeId !== null)
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  employeeId?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf(o => o.workOrderId !== null)
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  workOrderId?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf(o => o.counterpartyId !== null)
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  counterpartyId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() startAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() endAt?: string;
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
