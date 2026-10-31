import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { UUID_REGEX } from '@sto/shared';
import { csvArray } from '../transforms/csv-array';
import { emptyToUndefined } from '../transforms/empty-to-undefined';
import { CALENDAR_DATE_RE } from '../utils/kyiv-date';

/**
 * Поля пагінації й напряму сортування query-DTO списків одним декоратором кожне. Нові списки
 * беруть їх, а не копіюють шість декораторів на поле (CI-гейт нових клонів, 2026-10-26).
 */
export const SortDirParam = (description = 'Напрям сортування') =>
  applyDecorators(
    ApiPropertyOptional({ enum: ['asc', 'desc'], description }),
    IsOptional(),
    IsIn(['asc', 'desc']),
  );

/** `page` — від 1. */
export const PageParam = () =>
  applyDecorators(
    // minimum/maximum — явно: swagger-плагін не бачить @Min/@Max усередині applyDecorators.
    ApiPropertyOptional({ default: 1, minimum: 1 }),
    IsOptional(),
    Type(() => Number),
    IsNumber(),
    Min(1),
  );

/** `limit` — від 1 до `max`. */
export const LimitParam = (defaultLimit: number, max = 200) =>
  applyDecorators(
    ApiPropertyOptional({ default: defaultLimit, minimum: 1, maximum: max }),
    IsOptional(),
    Type(() => Number),
    IsNumber(),
    Min(1),
    Max(max),
  );

/** `showDeleted=true` — показати видалені записи. */
export const ShowDeletedParam = () =>
  applyDecorators(
    ApiPropertyOptional({ description: 'Показати видалені' }),
    IsOptional(),
    Transform(({ value }: { value: unknown }) => value === 'true' || value === true),
    IsBoolean(),
  );

/**
 * Записи за id: `?ids=a,b` або повторений параметр (Fastify віддає масивом) → масив UUID, до `max`
 * (як `limit`); порожньо — `undefined`. `maxMessage` — ключ помилки довідника.
 */
export const IdsParam = (description: string, maxMessage: string, max = 200) =>
  applyDecorators(
    // maxItems — явно: swagger-плагін не бачить @ArrayMaxSize усередині applyDecorators.
    ApiPropertyOptional({ type: String, description, maxItems: max }),
    IsOptional(),
    Transform(csvArray),
    IsArray(),
    ArrayMaxSize(max, { message: maxMessage }),
    Matches(UUID_REGEX, { each: true }),
  );

/** Межа періоду списку (`dateFrom` / `dateTo`): календарна дата `YYYY-MM-DD`, порожньо — без меж. */
export const CalendarDateParam = (description: string) =>
  applyDecorators(
    ApiPropertyOptional({ description }),
    IsOptional(),
    Transform(emptyToUndefined),
    Matches(CALENDAR_DATE_RE),
    IsDateString({ strict: true }),
  );
