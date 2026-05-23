import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { UserRole } from '@prisma/client';
import { z } from 'zod';

// ─── rateScheme Zod validation ────────────────────────────

export const rateSchemeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('percent_normo'),
    params: z.object({ percent: z.number().min(0).max(100) }),
  }),
  z.object({
    type: z.literal('fixed_plus_bonus'),
    params: z.object({ fixedMonthly: z.number().min(0), bonusPercent: z.number().min(0).max(100) }),
  }),
]);

export type RateScheme = z.infer<typeof rateSchemeSchema>;

// ─── DTOs ────────────────────────────────────────────────

export class CreateEmployeeDto {
  @ApiProperty({ example: 'Іван' })
  @IsString()
  firstName!: string;

  @ApiProperty({ example: 'Коваль' })
  @IsString()
  lastName!: string;

  @ApiProperty({ enum: UserRole })
  @IsEnum(UserRole)
  role!: UserRole;

  @ApiProperty({
    example: { type: 'percent_normo', params: { percent: 40 } },
    description: 'percent_normo | fixed_plus_bonus',
  })
  rateScheme!: RateScheme;

  @ApiPropertyOptional({ example: '+38 (067) 123-45-67' })
  @IsOptional()
  @IsString()
  phone?: string;
}

export class UpdateEmployeeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({ enum: UserRole })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional()
  @IsOptional()
  rateScheme?: RateScheme;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  phone?: string;
}

export class AssignZonesDto {
  @ApiProperty({ type: [String], description: 'Масив UUID зон' })
  @IsUUID('4', { each: true })
  zoneIds!: string[];
}

export class AssignLiftsDto {
  @ApiProperty({ type: [String], description: 'Масив UUID підйомників' })
  @IsUUID('4', { each: true })
  liftIds!: string[];
}

export class AssignWorkCategoriesDto {
  @ApiProperty({ type: [String], description: 'Масив UUID категорій робіт' })
  @IsUUID('4', { each: true })
  workCategoryIds!: string[];
}

export class EmployeeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiPropertyOptional() userId?: string | null;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty({ enum: UserRole }) role!: UserRole;
  @ApiPropertyOptional() phone?: string | null;
  @ApiProperty({ type: [String] }) zoneIds!: string[];
  @ApiProperty({ type: [String] }) liftIds!: string[];
  @ApiProperty({ type: [String] }) workCategoryIds!: string[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class EmployeeDetailDto extends EmployeeResponseDto {
  @ApiProperty({ description: 'Схема нарахування (тільки OWNER/ADMIN)' }) rateScheme!: RateScheme;
}
