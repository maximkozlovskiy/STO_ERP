import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class CreateWorkCategoryDto {
  @ApiProperty({ example: 'Р”РІРёРіСѓРЅ' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    description: 'UUID Р±Р°С‚СЊРєС–РІСЃСЊРєРѕС— РєР°С‚РµРіРѕСЂС–С— (null = РєРѕСЂРµРЅРµРІР°)',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateWorkCategoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class ToggleActiveCategoryDto {
  @ApiProperty()
  @IsBoolean()
  isActive!: boolean;
}

export class WorkCategoryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiPropertyOptional() parentId?: string | null;
  @ApiPropertyOptional() code?: string | null;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() icon?: string | null;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() isSystem!: boolean;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ type: () => [WorkCategoryResponseDto] }) children!: WorkCategoryResponseDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
