import {
  IsString,
  IsIn,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  IsOptional,
  IsDateString,
  IsBoolean,
  Matches,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { REGISTRY, ALLOWED_OPS, ALLOWED_AGGS } from './report-registry';

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENTITY_KEYS = Object.keys(REGISTRY);

export class ReportFilterDto {
  @ApiProperty() @IsString() field!: string;
  @ApiProperty({ enum: ALLOWED_OPS }) @IsIn(ALLOWED_OPS as unknown as string[]) op!: string;
  @ApiPropertyOptional() @IsOptional() value?: unknown;
}

export class ReportSortDto {
  @ApiProperty() @IsString() field!: string;
  @ApiProperty({ enum: ['asc', 'desc'] }) @IsIn(['asc', 'desc']) dir!: 'asc' | 'desc';
}

export class ReportAggDto {
  @ApiProperty() @IsString() field!: string;
  @ApiProperty({ enum: ALLOWED_AGGS }) @IsIn(ALLOWED_AGGS as unknown as string[]) agg!: string;
}

export class ReportDateRangeDto {
  @ApiProperty() @IsDateString({ strict: true }) @Matches(YMD_RE) from!: string;
  @ApiProperty() @IsDateString({ strict: true }) @Matches(YMD_RE) to!: string;
}

export class ReportSortByAggregateDto {
  @ApiProperty({ description: "alias агрегату, напр. 'SUM_amount'" })
  @IsString()
  alias!: string;
  @ApiProperty({ enum: ['asc', 'desc'] })
  @IsIn(['asc', 'desc'])
  dir!: 'asc' | 'desc';
}

export class ReportConfigDto {
  @ApiProperty({ enum: ENTITY_KEYS })
  @IsIn(ENTITY_KEYS)
  entity!: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  columns!: string[];

  @ApiProperty({ type: [String], description: 'До 5 рівнів ієрархічного групування' })
  @IsArray()
  @ArrayMaxSize(5, { message: 'Не більше 5 рівнів групування' })
  @IsString({ each: true })
  groupBy!: string[];

  @ApiPropertyOptional({ type: [ReportFilterDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ReportFilterDto)
  filters?: ReportFilterDto[];

  @ApiPropertyOptional({ type: [ReportSortDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => ReportSortDto)
  sort?: ReportSortDto[];

  @ApiPropertyOptional({ type: [ReportAggDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ReportAggDto)
  aggregations?: ReportAggDto[];

  @ApiPropertyOptional({ type: ReportDateRangeDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReportDateRangeDto)
  dateRange?: ReportDateRangeDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includeRows?: boolean;

  @ApiPropertyOptional({ description: 'Сортування груп за агрегатом: {alias, dir}' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReportSortByAggregateDto)
  sortByAggregate?: ReportSortByAggregateDto;
}

export class ReportRunDto {
  @ApiProperty({ type: ReportConfigDto })
  @ValidateNested()
  @Type(() => ReportConfigDto)
  config!: ReportConfigDto;
}

export class SaveReportDto {
  @ApiProperty() @IsString() @MaxLength(200) name!: string;
  @ApiProperty({ type: ReportConfigDto })
  @ValidateNested()
  @Type(() => ReportConfigDto)
  config!: ReportConfigDto;
}

export class UpdateSavedReportDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) name?: string;
  @ApiPropertyOptional({ type: ReportConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReportConfigDto)
  config?: ReportConfigDto;
}
