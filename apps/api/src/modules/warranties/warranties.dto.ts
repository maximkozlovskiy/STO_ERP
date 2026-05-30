import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateWarrantyDto {
  @ApiProperty()
  @IsUUID('4')
  workOrderId!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  workOrderLineId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  workOrderPartId?: string;
  @ApiProperty()
  @IsUUID('4')
  counterpartyId!: string;
  @ApiProperty() @IsDateString() expiresAt!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
}

export class ClaimWarrantyDto {
  @ApiProperty()
  @IsUUID('4')
  claimWoId!: string;
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
