import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { PaymentSourceType } from '@prisma/client';

/**
 * Куди надходять кошти цього способу оплати: тип рахунку-призначення і сама каса або банківський
 * рахунок. Платіж бере їх, коли в запиті рахунку-призначення немає (BR-PAY-002). `null` у будь-
 * якому з полів разом із `defaultSourceType: null` знімає призначення; при зміні типу id іншого
 * типу обнуляється. Каса — лише з `CASH_REGISTER`, рахунок — лише з `BANK_ACCOUNT` (інакше 400).
 */
class PaymentMethodDestinationDto {
  @ApiPropertyOptional({ enum: PaymentSourceType, nullable: true })
  @IsOptional()
  @IsEnum(PaymentSourceType)
  defaultSourceType?: PaymentSourceType | null;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  defaultCashRegisterId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  defaultBankAccountId?: string | null;
}

export class CreatePaymentMethodDto extends PaymentMethodDestinationDto {
  @ApiProperty({ example: 'cash' })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiProperty({ example: 'Готівка' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresFiscal?: boolean;
}

export class UpdatePaymentMethodDto extends PaymentMethodDestinationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresFiscal?: boolean;
}

export class PaymentMethodResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() isSystem!: boolean;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() requiresFiscal!: boolean;
  @ApiProperty({ enum: PaymentSourceType, nullable: true })
  defaultSourceType!: PaymentSourceType | null;
  @ApiProperty({ type: String, nullable: true }) defaultCashRegisterId!: string | null;
  @ApiProperty({ type: String, nullable: true }) defaultBankAccountId!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Назва каси чи банківського рахунку-призначення; null — не вказано або видалено',
  })
  defaultDestinationName!: string | null;
  @ApiProperty() updatedAt!: string;
}
