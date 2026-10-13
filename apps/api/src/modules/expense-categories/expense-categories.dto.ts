import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { CashOperationReason, ExpenseCategoryType } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';
import { emptyToNull } from '../../common/transforms/empty-to-null';

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
  @IsEnum(ExpenseCategoryType)
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

  @ApiPropertyOptional({
    enum: CashOperationReason,
    nullable: true,
    description:
      'Привід за замовчуванням: касова операція з цим приводом без указаної статті отримує цю статтю. null (або порожній рядок) знімає привід',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @IsEnum(CashOperationReason)
  defaultReason?: CashOperationReason | null;
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

  @ApiPropertyOptional({
    enum: CashOperationReason,
    nullable: true,
    description:
      'Привід за замовчуванням: касова операція з цим приводом без указаної статті отримує цю статтю. null (або порожній рядок) знімає привід',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @IsEnum(CashOperationReason)
  defaultReason?: CashOperationReason | null;
}

export { TYPE_VALUES as EXPENSE_CATEGORY_TYPES };

export class ExpenseCategoryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) parentId?: string | null;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ExpenseCategoryType }) type!: ExpenseCategoryType;
  @ApiProperty({
    enum: CashOperationReason,
    nullable: true,
    description: 'Привід за замовчуванням (один привід — одна стаття в організації)',
  })
  defaultReason!: CashOperationReason | null;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ type: () => [ExpenseCategoryResponseDto], description: 'Дочірні статті (дерево)' })
  children!: ExpenseCategoryResponseDto[];
  @ApiPropertyOptional({ type: String, nullable: true }) deletedAt?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
