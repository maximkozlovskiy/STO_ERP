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

// rateScheme-схема тепер у @sto/shared (ЄДИНЕ джерело правди web ↔ api) — реекспорт для
// зворотної сумісності імпортів (employees.service та ін.).
export { rateSchemeSchema, type RateScheme } from '@sto/shared';
import type { RateScheme } from '@sto/shared';

// в”Ђв”Ђв”Ђ DTOs в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

export class CreateEmployeeDto {
  @ApiProperty({ example: 'Р†РІР°РЅ' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName!: string;

  @ApiProperty({ example: 'РљРѕРІР°Р»СЊ' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName!: string;

  @ApiProperty({ enum: UserRole })
  @IsEnum(UserRole)
  role!: UserRole;

  @ApiProperty({
    example: { type: 'percent_normo', params: { percent: 40 } },
    description: 'percent_normo | per_normo_hour | fixed_plus_bonus',
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
    description:
      'Email РґР»СЏ РІС…РѕРґСѓ РІ СЃРёСЃС‚РµРјСѓ (Р»РѕРіС–РЅ). РЇРєС‰Рѕ РІРєР°Р·Р°РЅРѕ вЂ” СЃС‚РІРѕСЂСЋС” AuthAccount',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEmail({}, { message: 'err.dto.employee.loginEmail.invalid' })
  @MaxLength(254)
  loginEmail?: string;

  @ApiPropertyOptional({
    description:
      "РџР°СЂРѕР»СЊ РґР»СЏ РІС…РѕРґСѓ. РћР±РѕРІ'СЏР·РєРѕРІРёР№ СЏРєС‰Рѕ РІРєР°Р·Р°РЅРѕ loginEmail",
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MinLength(6, { message: 'err.dto.employee.password.min' })
  @MaxLength(128, {
    message: 'err.dto.employee.password.max',
  })
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

// Query DTO for `GET /employees` вЂ” without it the controller silently dropped q/role/showDeleted
// (NestJS @Query without DTO has no whitelisting, so the params arrived but were never read).
export class EmployeesQueryDto {
  @ApiPropertyOptional({
    description: "РџРѕС€СѓРє Р·Р° С–Рј'СЏРј, РїСЂС–Р·РІРёС‰РµРј Р°Р±Рѕ С‚РµР»РµС„РѕРЅРѕРј",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: UserRole, description: 'Р¤С–Р»СЊС‚СЂ Р·Р° РїРѕСЃР°РґРѕСЋ' })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ description: 'РџРѕРєР°Р·Р°С‚Рё soft-deleted' })
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

  @ApiPropertyOptional({
    description: 'РџРѕР»Рµ СЃРѕСЂС‚СѓРІР°РЅРЅСЏ',
    enum: ['lastName', 'createdAt'],
  })
  @IsOptional()
  @IsIn(['lastName', 'createdAt'])
  sortBy?: string;

  @ApiPropertyOptional({ description: 'РќР°РїСЂСЏРј СЃРѕСЂС‚СѓРІР°РЅРЅСЏ', enum: ['asc', 'desc'] })
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
  @ApiProperty({ type: [String], description: 'РњР°СЃРёРІ UUID С„С–Р»С–Р№' })
  @IsUUID(undefined, { each: true })
  @ArrayMaxSize(50, { message: 'err.dto.employee.branches.max' })
  branchIds!: string[];

  @ApiPropertyOptional({ description: 'Р”РѕСЃС‚СѓРї РґРѕ РІСЃС–С… С„С–Р»С–Р№ (OWNER/ADMIN)' })
  @IsOptional()
  @IsBoolean()
  allBranches?: boolean;
}

export class AssignZonesDto {
  @ApiProperty({ type: [String], description: 'РњР°СЃРёРІ UUID Р·РѕРЅ' })
  @IsUUID(undefined, { each: true })
  @ArrayMaxSize(30, { message: 'err.dto.employee.zones.max' })
  zoneIds!: string[];
}

export class AssignLiftsDto {
  @ApiProperty({ type: [String], description: 'РњР°СЃРёРІ UUID РїС–РґР№РѕРјРЅРёРєС–РІ' })
  @IsUUID(undefined, { each: true })
  @ArrayMaxSize(30, {
    message: 'err.dto.employee.lifts.max',
  })
  liftIds!: string[];
}

export class AssignWorkCategoriesDto {
  @ApiProperty({ type: [String], description: 'РњР°СЃРёРІ UUID РєР°С‚РµРіРѕСЂС–Р№ СЂРѕР±С–С‚' })
  @IsUUID(undefined, { each: true })
  @ArrayMaxSize(50, {
    message: 'err.dto.employee.categories.max',
  })
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
  @ApiPropertyOptional() dateOfHire?: string | null;
  @ApiPropertyOptional() dateOfFire?: string | null;
  @ApiProperty({ type: [String] }) zoneIds!: string[];
  @ApiProperty({ type: [String] }) liftIds!: string[];
  @ApiProperty({ type: [String] }) workCategoryIds!: string[];
  @ApiProperty({ type: [String] }) branchIds!: string[];
  @ApiProperty() allBranches!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({ description: 'Set when the employee is soft-deleted' })
  deletedAt?: string | null;
}

export class EmployeeDetailDto extends EmployeeResponseDto {
  @ApiProperty({ description: 'РЎС…РµРјР° РЅР°СЂР°С…СѓРІР°РЅРЅСЏ (С‚С–Р»СЊРєРё OWNER/ADMIN)' })
  rateScheme!: RateScheme;
}
