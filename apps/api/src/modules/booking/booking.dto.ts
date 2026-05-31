import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class BookingAvailabilityQueryDto {
  @ApiProperty() @IsDateString() date!: string;
  @ApiProperty()
  @IsUUID()
  branchId!: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsArray()
  // Bug #251: cap unbounded array on PUBLIC endpoint — без cap зловмисник може
  // POST-ити Array(1_000_000).fill(UUID) → ValidationPipe виконає N×regex (DoS).
  // 50 — реалістичний максимум для одного бронювання (узгоджено з inspection.dto).
  @ArrayMaxSize(50, { message: 'Не більше 50 послуг' })
  @IsUUID(undefined, { each: true })
  serviceIds?: string[];
}

export class CreateBookingRequestDto {
  @ApiProperty()
  @IsUUID()
  branchId!: string;
  @ApiProperty() @IsString() @MaxLength(200) clientName!: string;
  @ApiProperty()
  @IsString()
  @Matches(/^\+380\d{9}$/, { message: 'Телефон має бути у форматі +380XXXXXXXXX' })
  clientPhone!: string;
  @ApiProperty() @IsDateString() requestedDate!: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsArray()
  // Bug #251: cap unbounded array на PUBLIC endpoint (див. AvailabilityQueryDto).
  @ArrayMaxSize(50, { message: 'Не більше 50 послуг' })
  @IsUUID(undefined, { each: true })
  serviceIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class ConfirmBookingDto {
  @ApiProperty()
  @IsUUID()
  slotId!: string;
}

export class AvailabilitySlotDto {
  @ApiProperty() startAt!: string;
  @ApiProperty() endAt!: string;
  @ApiProperty() liftId!: string;
  @ApiProperty() liftName!: string;
  @ApiProperty() available!: boolean;
}

export class BookingRequestResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() status!: string;
  @ApiProperty() clientName!: string;
  @ApiProperty() clientPhone!: string;
  @ApiProperty() requestedDate!: string;
  @ApiProperty() branchId!: string;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() createdAt!: string;
}
