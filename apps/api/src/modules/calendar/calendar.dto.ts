import {
  IsUUID,
  IsOptional,
  IsString,
  IsISO8601,
  IsEnum,
  IsDateString,
  IsBoolean,
} from 'class-validator';
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

  // emptyToUndefined gap: enum fields were missing the transform — default empty-string state `''` → 400.
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

  // emptyToUndefined gap in PATCH — partial-update with empty string → 400 without transform.
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

  /**
   * Перетягування чи зміна меж запису у виді «День» (BR-CAL-012): механік запису, не закріплений
   * за новим підйомником, знімається (`employeeId: null`) замість 400. Форма запису поля не шле —
   * для неї незакріплений механік і далі 400.
   */
  @ApiPropertyOptional({
    description:
      'Перетягування: механік запису, не закріплений за новим підйомником, знімається замість 400',
  })
  @IsOptional()
  @IsBoolean()
  dropMechanicNotOnLift?: boolean;
}

export class CalendarSlotResponseDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() liftId?: string | null;
  @ApiPropertyOptional() employeeId?: string | null;
  @ApiPropertyOptional() workOrderId?: string | null;
  @ApiPropertyOptional() vehicleId?: string | null;
  @ApiPropertyOptional() parentSlotId?: string | null;
  @ApiProperty() startAt!: string;
  @ApiProperty() endAt!: string;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional() workOrderNumber?: string;
  @ApiPropertyOptional() workOrderStatus?: string | null;
  /**
   * Наряд запису видалено (soft delete; BR-CAL-011). `GET /calendar/slots` таких записів не
   * повертає (BR-WO-017 позначає їх видаленими разом із нарядом), тож тут завжди `false`; поле —
   * захисна позначка, яку web відкидає, якщо такий запис усе ж прийде.
   */
  @ApiPropertyOptional({
    description:
      'Наряд запису видалено (BR-CAL-011). GET /calendar/slots таких записів не повертає',
  })
  workOrderDeleted?: boolean;
  /**
   * Лише відповідь `PATCH` з `dropMechanicNotOnLift`: механіка знято, бо він не закріплений за
   * новим підйомником (BR-CAL-012). Відсутнє — механіка не знімали.
   */
  @ApiPropertyOptional({
    description: 'Механіка знято: не закріплений за новим підйомником (лише PATCH з перетягування)',
  })
  mechanicDropped?: boolean;
  @ApiPropertyOptional() counterpartyId?: string | null;
  @ApiPropertyOptional() counterpartyName?: string;
  @ApiPropertyOptional() cpPhone?: string | null;
  @ApiPropertyOptional() vehicleSummary?: string | null;
  @ApiPropertyOptional() vehiclePlate?: string | null;
  /**
   * Механік запису «Прізвище Ім'я»; `null` — не призначено (BR-CAL-011). Віддає лише
   * `GET /calendar/slots` (і ролі MECHANIC); відповіді створення, зміни й перевірки конфліктів
   * поля не мають.
   */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "Механік запису «Прізвище Ім'я»; null — не призначено. Лише GET /calendar/slots",
  })
  employeeName?: string | null;
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

  // Exclude slots of the same work order during conflict check — otherwise any WO being edited
  // conflicts with its own existing slot. excludeSlotId is insufficient: a WO can have multiple
  // slots (split-across-days), so filter by workOrderId instead.
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
