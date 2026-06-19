import { IsUUID, IsString, IsOptional, IsBoolean, IsInt, IsDateString, Min } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class CreateMaintenanceScheduleDto {
  @ApiProperty()
  @IsUUID()
  vehicleId!: string;
  @ApiPropertyOptional({ default: 'REGULAR' }) @IsOptional() @IsString() maintenanceType?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) intervalDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) intervalMileage?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  lastMaintenanceDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) lastMaintenanceMileage?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class UpdateMaintenanceScheduleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() maintenanceType?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) intervalDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) intervalMileage?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  lastMaintenanceDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) lastMaintenanceMileage?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) nextMaintenanceMileage?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class MaintenanceScheduleResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() vehicleId!: string;
  @ApiPropertyOptional() vehicleLabel?: string;
  @ApiProperty() maintenanceType!: string;
  @ApiPropertyOptional() intervalDays?: number | null;
  @ApiPropertyOptional() intervalMileage?: number | null;
  @ApiPropertyOptional() lastMaintenanceDate?: string | null;
  @ApiPropertyOptional() lastMaintenanceMileage?: number | null;
  @ApiPropertyOptional() nextMaintenanceDate?: string | null;
  @ApiPropertyOptional() nextMaintenanceMileage?: number | null;
  @ApiProperty() isActive!: boolean;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class UpcomingMaintenanceQueryDto {
  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  days: number = 30;
}
