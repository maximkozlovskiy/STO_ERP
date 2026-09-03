import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';
// в”Ђв”Ђв”Ђ Vehicle в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

export class CreateVehicleDto {
  @ApiProperty()
  @IsUUID()
  customerGarageId!: string;
  @ApiProperty({ example: 'Toyota' }) @IsString() @IsNotEmpty() make!: string;
  @ApiProperty({ example: 'Camry' }) @IsString() @IsNotEmpty() model!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vin?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() licensePlate?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() year?: number;
  @ApiPropertyOptional() @IsOptional() engineVolume?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() fuelType?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) currentMileage?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() color?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() transmissionType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() driveType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bodyType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() engineCode?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  insuranceExpiry?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  inspectionExpiry?: string;
}

export class UpdateVehicleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() make?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() model?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vin?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() licensePlate?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() year?: number;
  @ApiPropertyOptional() @IsOptional() engineVolume?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() fuelType?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) currentMileage?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() color?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() transmissionType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() driveType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bodyType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() engineCode?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  insuranceExpiry?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  inspectionExpiry?: string;
}

export class VehicleResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() customerGarageId!: string;
  @ApiProperty() make!: string;
  @ApiProperty() model!: string;
  @ApiPropertyOptional() vin?: string | null;
  @ApiPropertyOptional() licensePlate?: string | null;
  @ApiPropertyOptional() year?: number | null;
  @ApiPropertyOptional() engineVolume?: number | null;
  @ApiPropertyOptional() fuelType?: string | null;
  @ApiPropertyOptional() currentMileage?: number | null;
  @ApiPropertyOptional() color?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional() transmissionType?: string | null;
  @ApiPropertyOptional() driveType?: string | null;
  @ApiPropertyOptional() bodyType?: string | null;
  @ApiPropertyOptional() engineCode?: string | null;
  @ApiPropertyOptional() insuranceExpiry?: string | null;
  @ApiPropertyOptional() inspectionExpiry?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({ description: 'Проставлене коли авто soft-deleted' })
  deletedAt?: string | null;
}

// в”Ђв”Ђв”Ђ VehicleNode в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

export class CreateVehicleNodeDto {
  @ApiProperty({ example: 'engine' }) @IsString() @IsNotEmpty() category!: string;
  @ApiProperty({ example: 'Р”РІРёРіСѓРЅ 2.0 TSI' }) @IsString() @IsNotEmpty() name!: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) mileageAtInstall?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class VehicleNodeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() category!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() mileageAtInstall?: number | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() createdAt!: string;
}
