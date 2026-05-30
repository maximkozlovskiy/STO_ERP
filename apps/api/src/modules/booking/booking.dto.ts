import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
} from 'class-validator';

export class BookingAvailabilityQueryDto {
  @ApiProperty() @IsDateString() date!: string;
  @ApiProperty()
  @IsUUID('4')
  branchId!: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  serviceIds?: string[];
}

export class CreateBookingRequestDto {
  @ApiProperty()
  @IsUUID('4')
  branchId!: string;
  @ApiProperty() @IsString() @MaxLength(200) clientName!: string;
  @ApiProperty()
  @IsString()
  @Matches(/^\+380\d{9}$/, { message: 'Телефон має бути у форматі +380XXXXXXXXX' })
  clientPhone!: string;
  @ApiProperty() @IsDateString() requestedDate!: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  serviceIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class ConfirmBookingDto {
  @ApiProperty()
  @IsUUID('4')
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
