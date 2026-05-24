import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateBranchDto {
  @ApiProperty({ example: 'Головна філія' })
  @IsString() @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'вул. Гагаріна 12, Київ' })
  @IsString() @IsNotEmpty()
  address!: string;

  @ApiPropertyOptional({ example: 'Europe/Kyiv' })
  @IsOptional()
  @IsString()
  timezone?: string;
}

export class UpdateBranchDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  timezone?: string;
}

export class BranchResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() address!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
