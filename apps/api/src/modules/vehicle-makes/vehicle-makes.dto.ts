import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { VehicleMakeDto, VehicleModelDto } from '@sto/shared';

/**
 * Тіла запитів валідує `ZodValidationPipe` зі схемами `@sto/shared` (`vehicleMakeSchema`,
 * `vehicleModelSchema`, `vehicleDirectoryMergeSchema`); класи нижче — лише опис для Swagger.
 */
export class VehicleDirectoryNameDto {
  @ApiProperty({ example: 'Toyota', maxLength: 100 }) name!: string;
}

export class VehicleDirectoryMergeDto {
  @ApiProperty({ description: 'Марка чи модель, у яку переходять авто', format: 'uuid' })
  targetId!: string;
}

export class VehicleMakeResponseDto implements VehicleMakeDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'Живі авто цієї марки — з ними марку не видалити (BR-VEH-009)' })
  vehicleCount!: number;
  @ApiProperty({ description: 'Живі моделі марки' }) modelCount!: number;
  @ApiPropertyOptional({ type: String, nullable: true }) deletedAt!: string | null;
}

export class VehicleMakeListResponseDto {
  @ApiProperty({ type: [VehicleMakeResponseDto] }) items!: VehicleMakeResponseDto[];
  @ApiProperty() total!: number;
}

export class VehicleModelResponseDto implements VehicleModelDto {
  @ApiProperty() id!: string;
  @ApiProperty() makeId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'Живі авто цієї моделі — з ними модель не видалити (BR-VEH-009)' })
  vehicleCount!: number;
  @ApiPropertyOptional({ type: String, nullable: true }) deletedAt!: string | null;
}

export class VehicleModelListResponseDto {
  @ApiProperty({ type: [VehicleModelResponseDto] }) items!: VehicleModelResponseDto[];
  @ApiProperty() total!: number;
}
