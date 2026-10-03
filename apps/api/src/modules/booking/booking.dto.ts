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
import { PHONE_UA_REGEX } from '@sto/shared';
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
  // Cap unbounded array on PUBLIC endpoint — без cap зловмисник може
  // POST-ити Array(1_000_000).fill(UUID) → ValidationPipe виконає N×regex (DoS).
  // 50 — реалістичний максимум для одного бронювання (узгоджено з inspection.dto).
  @ArrayMaxSize(50, { message: 'err.dto.booking.services.max' })
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
  @Matches(PHONE_UA_REGEX, { message: 'err.dto.booking.phone.format' })
  clientPhone!: string;
  @ApiProperty() @IsDateString() requestedDate!: string;
  // Обраний ліфт слота (getAvailability повертає його у кожному слоті). Заявка блокує САМЕ цей
  // ліфт; на confirm матеріалізується CalendarSlot. Опційно (legacy без ліфта → блок усіх).
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  liftId?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsArray()
  // Cap unbounded array on PUBLIC endpoint (DoS guard — see AvailabilityQueryDto above).
  @ArrayMaxSize(50, { message: 'err.dto.booking.services.max' })
  @IsUUID(undefined, { each: true })
  serviceIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class ConfirmBookingDto {
  // CAL-H3/H4 (реалізовано): slotId опційний для backward-compat (confirm без body).
  // Коли переданий — сервіс валідує, що слот належить org викликача. Матеріалізація
  // слота на обраному ліфті заявки (BookingRequest.liftId) відбувається у
  // BookingService.confirm() → зайнятим стає САМЕ цей ліфт, не весь HH:MM на всіх.
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  slotId?: string;
}

export class AvailabilitySlotDto {
  @ApiProperty() startAt!: string;
  @ApiProperty() endAt!: string;
  @ApiProperty() liftId!: string;
  @ApiProperty() liftName!: string;
  @ApiProperty() available!: boolean;
}

/**
 * Статуси заявки. У схемі це `String @default("PENDING")` (не Prisma enum),
 * але сервіс пише рівно три значення: PENDING при create, CONFIRMED у confirm,
 * CANCELLED у cancel. Перелік у Swagger звужує тип у web до union — інакше
 * `req.status === 'REJECTED'` (неіснуючий статус) компілювався б мовчки.
 */
export const BOOKING_REQUEST_STATUSES = ['PENDING', 'CONFIRMED', 'CANCELLED'] as const;
export type BookingRequestStatusValue = (typeof BOOKING_REQUEST_STATUSES)[number];

export class BookingRequestResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: BOOKING_REQUEST_STATUSES }) status!: BookingRequestStatusValue;
  @ApiProperty() clientName!: string;
  @ApiProperty() clientPhone!: string;
  @ApiProperty() requestedDate!: string;
  @ApiProperty() branchId!: string;
  @ApiPropertyOptional() branchName?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() createdAt!: string;
}

// ─── Публічні філії для віджета запису ────────────────────────────────
// Контролер навмисно віддає звужену форму (без orgId) — DTO описує саме її,
// а не `GarageBranch`.

export class PublicBookingBranchDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) address!: string | null;
}

// Список заявок віддається як { items, total } без page/limit — пагінації у цього
// роуту немає, тож окремий DTO замість PaginatedXDto.
export class BookingRequestListDto {
  @ApiProperty({ type: [BookingRequestResponseDto] }) items!: BookingRequestResponseDto[];
  @ApiProperty() total!: number;
}
