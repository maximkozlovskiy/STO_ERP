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
  @ApiProperty({ enum: ALLOWED_OPS }) @IsIn(ALLOWED_OPS) op!: string;
  @ApiPropertyOptional() @IsOptional() value?: unknown;
}

export class ReportSortDto {
  @ApiProperty() @IsString() field!: string;
  @ApiProperty({ enum: ['asc', 'desc'] }) @IsIn(['asc', 'desc']) dir!: 'asc' | 'desc';
}

export class ReportAggDto {
  @ApiProperty() @IsString() field!: string;
  @ApiProperty({ enum: ALLOWED_AGGS }) @IsIn(ALLOWED_AGGS) agg!: string;
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
  @ArrayMaxSize(5, { message: 'err.dto.reportBuilder.groupBy.max' })
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

// ─── Response-DTO ────────────────────────────────────────────────────────────
// Вище — request-DTO (валідація). Нижче — ОПИСОВІ response-DTO: лише для Swagger
// і кодогенерації типів web, вони нічого не трансформують.
//
// МЕЖА ЗАСТОСОВНОСТІ. Конструктор звітів — ad-hoc: набір колонок задає користувач у
// рантаймі, тож `detailRows` і `aggregates` за своєю природою — відкриті мапи, а
// `GroupNode` рекурсивний (`children: GroupNode[]`). Їх НЕ можна описати точною
// схемою, не збрехавши. Тому типізуємо ТОЧНО конверт (entity, columns, groupBy,
// rowCount, truncated) і ЯВНО позначаємо динамічні частини як вільні обʼєкти —
// це honest-опис, а не заглушка (та сама межа, що зафіксована для ColumnMapping).

export class ReportMetadataFieldDto {
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ description: 'string | number | money | date | enum | boolean' }) type!: string;
  @ApiPropertyOptional({ description: 'Ключ у enums (для type=enum)' }) enumName?: string;
  @ApiProperty({ type: [String], description: 'Дозволені агрегації; порожньо = не агрегабельне' })
  aggregations!: string[];
  @ApiProperty() filterable!: boolean;
  @ApiProperty() groupable!: boolean;
}

export class ReportMetadataRelationDto {
  @ApiProperty({ description: "dot-path гілки: 'counterparty' | 'good.brand'" }) key!: string;
  @ApiProperty() label!: string;
  @ApiPropertyOptional({ description: 'Рідковживана гілка — ховається за «показати ще»' })
  advanced?: boolean;
}

export class ReportMetadataEntityDto {
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
  @ApiPropertyOptional({ description: 'Поле для фільтра за періодом' }) dateField?: string;
  @ApiProperty({ type: [ReportMetadataFieldDto] }) fields!: ReportMetadataFieldDto[];
  @ApiProperty({ type: [ReportMetadataRelationDto] }) relations!: ReportMetadataRelationDto[];
}

export class ReportMetadataDto {
  @ApiProperty({ type: [ReportMetadataEntityDto] }) entities!: ReportMetadataEntityDto[];
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
    description: 'enumName → перелік допустимих значень',
  })
  enums!: Record<string, readonly string[]>;
}

export class ReportRunColumnDto {
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() type!: string;
  @ApiPropertyOptional() enumName?: string;
}

export class ReportRunAggregationDto {
  @ApiProperty() field!: string;
  @ApiProperty({ description: 'SUM | AVG | MIN | MAX | COUNT' }) agg!: string;
  @ApiProperty() type!: string;
  @ApiProperty() label!: string;
}

export class ReportRunResultBodyDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'Рекурсивне дерево груп (GroupNode[]); порожнє коли groupBy=[]',
  })
  tree!: unknown[];
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'Плоскі детальні рядки — набір ключів задає config.columns у рантаймі',
  })
  detailRows!: Record<string, unknown>[];
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number', nullable: true },
    description: 'alias агрегації → значення (null якщо нема даних)',
  })
  grandTotals!: Record<string, number | null>;
  @ApiProperty() rowCount!: number;
  @ApiProperty({ description: 'true — результат обрізано лімітом' }) truncated!: boolean;
}

export class ReportRunResponseDto {
  @ApiProperty({ description: 'Ключ сутності з реєстру' }) entity!: string;
  @ApiProperty({ type: [ReportRunColumnDto] }) columns!: ReportRunColumnDto[];
  @ApiProperty({ type: [String] }) groupBy!: string[];
  @ApiProperty({ type: [ReportRunAggregationDto], description: 'Явні + авто-SUM' })
  aggregations!: ReportRunAggregationDto[];
  @ApiProperty({ type: ReportRunResultBodyDto }) result!: ReportRunResultBodyDto;
}

export class SavedReportResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'Ключ сутності з реєстру' }) entity!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Збережений ReportConfig (валідність перевіряється при run)',
  })
  config!: unknown;
  @ApiPropertyOptional({ type: String, nullable: true }) createdBy?: string | null;
  @ApiProperty({
    type: String,
    description: 'BigInt → РЯДОК на транспорті (патч BigInt.prototype.toJSON у main.ts)',
  })
  syncVersion!: bigint;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  deletedAt?: Date | null;
}
