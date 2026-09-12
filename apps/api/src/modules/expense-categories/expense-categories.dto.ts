import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ExpenseCategoryType } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

const TYPE_VALUES = Object.values(ExpenseCategoryType); // ['EXPENSE','INCOME']

export class CreateExpenseCategoryDto {
  @ApiProperty({ example: 'Оренда' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    enum: ExpenseCategoryType,
    description: 'Тип: EXPENSE (витрата) | INCOME (оприбуткування)',
  })
  @IsOptional()
  @IsString()
  type?: ExpenseCategoryType;

  @ApiPropertyOptional({ description: 'Батьківська стаття (null = корінь)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

// Тип НЕ приймається в update (immutable після створення — інакше операції-витрати опинилися б зі
// статтею, що стала «оприбуткуванням»). parentId у update дозволяє переносити гілки.
export class UpdateExpenseCategoryDto {
  @ApiPropertyOptional({ example: 'Оренда' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ description: 'Новий батько (порожній рядок → корінь)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export { TYPE_VALUES as EXPENSE_CATEGORY_TYPES };

export class ExpenseCategoryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) parentId?: string | null;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ExpenseCategoryType }) type!: ExpenseCategoryType;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ type: () => [ExpenseCategoryResponseDto], description: 'Дочірні статті (дерево)' })
  children!: ExpenseCategoryResponseDto[];
  @ApiPropertyOptional({ type: String, nullable: true }) deletedAt?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
