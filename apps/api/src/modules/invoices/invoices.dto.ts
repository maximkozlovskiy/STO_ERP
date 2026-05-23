import { IsUUID, IsOptional, IsNumber, Min, IsString, IsDateString, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateInvoiceDto {
  @ApiProperty() @IsUUID() counterpartyId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() workOrderId?: string;
  @ApiProperty() @IsNumber() @Min(0.01) amount!: number;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dueDate?: string;
}

export class UpdateInvoiceDto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0.01) amount?: number;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dueDate?: string;
}

export class TransitionInvoiceDto {
  @ApiProperty({ enum: ['SENT', 'PAID', 'CANCELLED'] })
  @IsEnum(['SENT', 'PAID', 'CANCELLED'])
  status!: string;
}

export class InvoiceResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() number!: string;
  @ApiProperty() status!: string;
  @ApiProperty() counterpartyId!: string;
  @ApiPropertyOptional() counterpartyName?: string;
  @ApiPropertyOptional() workOrderId?: string | null;
  @ApiPropertyOptional() workOrderNumber?: string | null;
  @ApiProperty() amount!: number;
  @ApiPropertyOptional() dueDate?: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PaginatedInvoicesDto {
  @ApiProperty({ type: [InvoiceResponseDto] }) items!: InvoiceResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
