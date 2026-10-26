import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

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
