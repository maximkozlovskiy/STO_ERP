import { IsUUID, IsString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CompletionActStatus } from '@prisma/client';

export class SignCompletionActDto {
  @ApiPropertyOptional() @IsOptional() @IsString() signedBy?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() clientPhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class CompletionActLineDto {
  @ApiProperty() description!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() unitPrice!: number;
  @ApiProperty() amount!: number;
  @ApiPropertyOptional() workId?: string | null;
  @ApiPropertyOptional() goodId?: string | null;
}

export class CompletionActResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() workOrderId!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ enum: CompletionActStatus }) status!: CompletionActStatus;
  @ApiPropertyOptional() signedAt?: Date | null;
  @ApiPropertyOptional() signedBy?: string | null;
  @ApiPropertyOptional() clientPhone?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional() workOrderNumber?: string;
  @ApiPropertyOptional() counterpartyName?: string;
  @ApiPropertyOptional() vehicleLabel?: string;
  @ApiProperty({ type: [CompletionActLineDto] }) lines!: CompletionActLineDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
