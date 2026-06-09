import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsBoolean,
  IsBooleanString,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { EmployeeStatus, UserRole } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';
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
  @IsNotEmpty()
  @MaxLength(100)
  firstName!: string;

  @ApiProperty({ example: 'Коваль' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName!: string;

  @ApiProperty({ enum: UserRole })
  @IsEnum(UserRole)
  role!: UserRole;

  @ApiProperty({
    example: { type: 'percent_normo', params: { percent: 40 } },
    description: 'percent_normo | fixed_plus_bonus',
  })
  @IsObject()
  rateScheme!: RateScheme;

  @ApiPropertyOptional({ example: '+38 (067) 123-45-67' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ enum: EmployeeStatus })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  dateOfHire?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  dateOfFire?: string;

  @ApiPropertyOptional({
    description: 'Email для входу в систему (логін). Якщо вказано — створює AuthAccount',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEmail({}, { message: 'Невірний формат email для логіну' })
  @MaxLength(254)
  loginEmail?: string;

  @ApiPropertyOptional({ description: "Пароль для входу. Обов'язковий якщо вказано loginEmail" })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MinLength(6, { message: 'Пароль має бути не менше 6 символів' })
  @MaxLength(128, { message: 'Пароль занадто довгий (максимум 128 символів)' })
  password?: string;
}

export class UpdateEmployeeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional({ enum: UserRole })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  rateScheme?: RateScheme;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ enum: EmployeeStatus })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  dateOfHire?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  dateOfFire?: string;
}

// Query DTO for `GET /employees` — without it the controller silently dropped q/role/showDeleted
// (NestJS @Query without DTO has no whitelisting, so the params arrived but were never read).
export class EmployeesQueryDto {
  @ApiPropertyOptional({ description: "Пошук за ім'ям, прізвищем або телефоном" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: UserRole, description: 'Фільтр за посадою' })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ description: 'Показати soft-deleted' })
  @IsOptional()
  @IsBooleanString()
  showDeleted?: string;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'Поле сортування', enum: ['lastName', 'createdAt'] })
  @IsOptional()
  @IsIn(['lastName', 'createdAt'])
  sortBy?: string;

  @ApiPropertyOptional({ description: 'Напрям сортування', enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

export class AssignBranchesDto {
  @ApiProperty({ type: [String], description: 'Масив UUID філій' })
  @IsUUID(undefined, { each: true })
  @ArrayMaxSize(50, { message: 'Максимум 50 філій на співробітника' })
  branchIds!: string[];

  @ApiPropertyOptional({ description: 'Доступ до всіх філій (OWNER/ADMIN)' })
  @IsOptional()
  @IsBoolean()
  allBranches?: boolean;
}

export class AssignZonesDto {
  @ApiProperty({ type: [String], description: 'Масив UUID зон' })
  @IsUUID(undefined, { each: true })
  @ArrayMaxSize(30, { message: 'Максимум 30 зон на співробітника' })
  zoneIds!: string[];
}

export class AssignLiftsDto {
  @ApiProperty({ type: [String], description: 'Масив UUID підйомників' })
  @IsUUID(undefined, { each: true })
  @ArrayMaxSize(30, { message: 'Максимум 30 підйомників на співробітника' })
  liftIds!: string[];
}

export class AssignWorkCategoriesDto {
  @ApiProperty({ type: [String], description: 'Масив UUID категорій робіт' })
  @IsUUID(undefined, { each: true })
  @ArrayMaxSize(50, { message: 'Максимум 50 категорій робіт на співробітника' })
  workCategoryIds!: string[];
}

export class EmployeeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiPropertyOptional() userId?: string | null;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty({ enum: UserRole }) role!: UserRole;
  @ApiProperty({ enum: EmployeeStatus }) status!: EmployeeStatus;
  @ApiPropertyOptional() phone?: string | null;
  @ApiPropertyOptional() email?: string | null;
  @ApiPropertyOptional() dateOfHire?: Date | null;
  @ApiPropertyOptional() dateOfFire?: Date | null;
  @ApiProperty({ type: [String] }) zoneIds!: string[];
  @ApiProperty({ type: [String] }) liftIds!: string[];
  @ApiProperty({ type: [String] }) workCategoryIds!: string[];
  @ApiProperty({ type: [String] }) branchIds!: string[];
  @ApiProperty() allBranches!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiPropertyOptional({ description: 'Set when the employee is soft-deleted' })
  deletedAt?: Date | null;
}

export class EmployeeDetailDto extends EmployeeResponseDto {
  @ApiProperty({ description: 'Схема нарахування (тільки OWNER/ADMIN)' }) rateScheme!: RateScheme;
}
