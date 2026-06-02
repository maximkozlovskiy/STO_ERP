import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateBrandDto {
  @ApiProperty({ example: 'BMW' })
  @IsString()
  @IsNotEmpty()
  name!: string;
}

export class UpdateBrandDto {
  @ApiProperty({ example: 'BMW' })
  @IsString()
  @IsNotEmpty()
  name!: string;
}

export class BrandResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) deletedAt?: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
