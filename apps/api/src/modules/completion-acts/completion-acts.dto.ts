import { IsString, IsOptional } from 'class-validator';
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
  @ApiPropertyOptional() signedAt?: string | null;
  @ApiPropertyOptional() signedBy?: string | null;
  @ApiPropertyOptional() clientPhone?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional() workOrderNumber?: string;
  @ApiPropertyOptional() counterpartyName?: string;
  @ApiPropertyOptional() vehicleLabel?: string;
  @ApiPropertyOptional({ type: [CompletionActLineDto] }) lines?: CompletionActLineDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class PaginatedCompletionActsDto {
  @ApiProperty({ type: [CompletionActResponseDto] }) items!: CompletionActResponseDto[];
  @ApiProperty() total!: number;
}
