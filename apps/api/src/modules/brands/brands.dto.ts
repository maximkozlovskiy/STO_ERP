import { ApiProperty } from '@nestjs/swagger';
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
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
