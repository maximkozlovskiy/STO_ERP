import { IsUUID, IsOptional, IsString, IsISO8601, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CalendarSlotStatus, CalendarSlotType } from '@prisma/client';

export class CreateCalendarSlotDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() liftId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() employeeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() workOrderId?: string;
  @ApiProperty() @IsISO8601() startAt!: string;
  @ApiProperty() @IsISO8601() endAt!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional({ enum: CalendarSlotStatus }) @IsOptional() @IsEnum(CalendarSlotStatus) status?: CalendarSlotStatus;
  @ApiPropertyOptional({ enum: CalendarSlotType }) @IsOptional() @IsEnum(CalendarSlotType) type?: CalendarSlotType;
}

export class UpdateCalendarSlotDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() liftId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() employeeId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() workOrderId?: string | null;
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
  @ApiPropertyOptional() counterpartyName?: string;
  @ApiProperty({ enum: CalendarSlotStatus }) status!: CalendarSlotStatus;
  @ApiProperty({ enum: CalendarSlotType }) type!: CalendarSlotType;
}
