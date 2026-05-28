import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, Matches, IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateWarrantyDto {
  @ApiProperty() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) workOrderId!: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) workOrderLineId?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) workOrderPartId?: string;
  @ApiProperty() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) counterpartyId!: string;
  @ApiProperty() @IsDateString() expiresAt!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
}

export class ClaimWarrantyDto {
  @ApiProperty() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) claimWoId!: string;
}

export class WarrantyResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() workOrderId!: string;
  @ApiPropertyOptional() workOrderLineId?: string | null;
  @ApiPropertyOptional() workOrderPartId?: string | null;
  @ApiProperty() counterpartyId!: string;
  @ApiProperty() expiresAt!: string;
  @ApiProperty() description!: string;
  @ApiPropertyOptional() claimedAt?: string | null;
  @ApiPropertyOptional() claimWoId?: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  // joined fields
  @ApiPropertyOptional() workOrderNumber?: string;
  @ApiPropertyOptional() counterpartyName?: string;
}

export class WarrantyListDto {
  @ApiProperty({ type: [WarrantyResponseDto] }) items!: WarrantyResponseDto[];
  @ApiProperty() total!: number;
}
