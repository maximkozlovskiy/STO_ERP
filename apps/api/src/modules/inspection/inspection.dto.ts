import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export const INSPECTION_STATUSES = ['OK', 'WARN', 'CRITICAL'] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

export class InspectionPointDto {
  @ApiProperty() @IsString() @MaxLength(200) name!: string;
  @ApiProperty() @IsString() @MaxLength(200) value!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) unit?: string;
  // Whitelist enum values — @IsString() alone would accept any string.
  @ApiProperty({ enum: INSPECTION_STATUSES })
  @IsIn(INSPECTION_STATUSES)
  status!: InspectionStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class CreateInspectionDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(9999999) mileage?: number;
  @ApiProperty({ type: [InspectionPointDto] })
  @IsArray()
  // Bug #115: cap array size — typical inspection has 8 default points; 50 is
  // a comfortable upper bound. Without this, POST { points: Array(1e6).fill(...) }
  // passes validation and OOMs the Node process before Prisma sees it.
  @ArrayMaxSize(50, { message: 'Не більше 50 точок огляду' })
  @ValidateNested({ each: true })
  @Type(() => InspectionPointDto)
  points!: InspectionPointDto[];
}

export class InspectionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() workOrderId!: string;
  @ApiPropertyOptional() mileage?: number | null;
  @ApiProperty() points!: InspectionPointDto[];
  @ApiProperty() createdBy!: string;
  @ApiProperty() createdAt!: string;
  @ApiPropertyOptional() autoCreatedLines?: number;
}
