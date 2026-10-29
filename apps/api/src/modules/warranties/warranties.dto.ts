import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { WARRANTY_STATES, type WarrantyState } from '@sto/shared';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';
import { LIST_SEARCH_MAX_LENGTH } from '../../common/utils/like-pattern';
import { csvArray } from '../../common/transforms/csv-array';

export class CreateWarrantyDto {
  @ApiProperty()
  @IsUUID()
  workOrderId!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  workOrderLineId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  workOrderPartId?: string;
  @ApiProperty()
  @IsUUID()
  counterpartyId!: string;
  @ApiProperty() @IsDateString() expiresAt!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
}

export class ClaimWarrantyDto {
  @ApiProperty()
  @IsUUID()
  claimWoId!: string;
}

export class WarrantyResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() workOrderId!: string;
  @ApiPropertyOptional() workOrderLineId?: string | null;
  @ApiPropertyOptional() workOrderPartId?: string | null;
  @ApiProperty() counterpartyId!: string;
  @ApiProperty() expiresAt!: string;
  @ApiProperty() description!: string;
  @ApiPropertyOptional() claimedAt?: string | null;
  @ApiPropertyOptional() claimWoId?: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  // joined fields
  @ApiPropertyOptional() workOrderNumber?: string;
  @ApiPropertyOptional() counterpartyName?: string;
}

export class WarrantyListDto {
  @ApiProperty({ type: [WarrantyResponseDto] }) items!: WarrantyResponseDto[];
  @ApiProperty() total!: number;
}

export const WARRANTY_SORT_FIELDS = ['expiresAt', 'createdAt'] as const;
export type WarrantySortField = (typeof WARRANTY_SORT_FIELDS)[number];

/** BR-WAR-001…003: запит списку вкладки «Гарантії». */
export class WarrantyListQueryDto {
  @ApiPropertyOptional({ description: 'Пошук: № наряду, клієнт, номер авто' })
  @IsOptional()
  @IsString()
  @MaxLength(LIST_SEARCH_MAX_LENGTH)
  q?: string;

  @ApiPropertyOptional({
    description: 'Стани через кому (ACTIVE,EXPIRING,EXPIRED,CLAIMED)',
    type: String,
    example: 'ACTIVE,EXPIRING',
  })
  @IsOptional()
  // `?state=A,B` і повторений `?state=A&state=B` (масив від Fastify).
  @Transform(csvArray)
  @IsArray()
  @ArrayMaxSize(WARRANTY_STATES.length)
  @IsIn(WARRANTY_STATES, { each: true })
  state?: WarrantyState[];

  @ApiPropertyOptional({ description: "Лише ця гарантія (посилання «Пов'язані документи»)" })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  id?: string;

  @ApiPropertyOptional({ enum: WARRANTY_SORT_FIELDS, description: 'Типово — expiresAt' })
  @IsOptional()
  @IsIn(WARRANTY_SORT_FIELDS)
  sortBy?: WarrantySortField;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], description: 'Типово — asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  limit: number = 20;
}

/** Рядок списку: поля гарантії + авто наряду і стан (BR-WAR-001, BR-WAR-002). */
export class WarrantyListItemDto extends WarrantyResponseDto {
  @ApiProperty({ type: String, nullable: true, description: 'Марка, модель, номер авто наряду' })
  vehicleSummary!: string | null;

  @ApiProperty({ enum: WARRANTY_STATES })
  state!: WarrantyState;
}

export class PaginatedWarrantiesDto {
  @ApiProperty({ type: [WarrantyListItemDto] }) items!: WarrantyListItemDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
