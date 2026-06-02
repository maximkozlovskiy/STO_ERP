import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class CreateGoodCategoryDto {
  @ApiProperty({ example: 'Двигун' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ description: 'UUID батьківської категорії (null = коренева)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateGoodCategoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class ToggleActiveDto {
  @ApiProperty()
  @IsBoolean()
  isActive!: boolean;
}

export class GoodCategoryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiPropertyOptional() parentId?: string | null;
  @ApiPropertyOptional() code?: string | null;
  @ApiProperty() name!: string;
  @ApiProperty() isSystem!: boolean;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() sortOrder!: number;
  @ApiProperty({ type: () => [GoodCategoryResponseDto] }) children!: GoodCategoryResponseDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
