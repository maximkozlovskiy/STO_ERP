import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class InspectionPointDto {
  @ApiProperty() @IsString() name!: string;
  @ApiProperty() @IsString() value!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() unit?: string;
  @ApiProperty({ enum: ['OK', 'WARN', 'CRITICAL'] }) @IsString() status!: 'OK' | 'WARN' | 'CRITICAL';
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class CreateInspectionDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(9999999) mileage?: number;
  @ApiProperty({ type: [InspectionPointDto] })
  @IsArray()
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
