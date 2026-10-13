import { BadRequestException } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { getLocale } from '../tenant/tenant-context';

/** Опція `findOne` документа: показати й позначений на видалення (BR-WO-012). */
export interface WithDeletedOption {
  withDeleted?: boolean;
}

/** Опис параметра для Swagger — один текст на всі маршрути `GET :id` документів. */
export const WITH_DELETED_API_QUERY = {
  name: 'withDeleted',
  required: false,
  type: Boolean,
  description:
    'true — повернути документ, навіть якщо він позначений на видалення (лише перегляд). ' +
    'Приймає тільки true або false.',
} as const;

/**
 * Query-параметр `withDeleted` маршруту `GET /<документ>/:id` (BR-WO-012).
 *
 * Приймає ЛИШЕ рядки `true` / `false`; усе інше (`abc`, `1`, порожнє значення, повтор параметра)
 * → 400 з тим самим текстом і формою відповіді, що дає `@IsBooleanString()` у DTO списків.
 * Параметра немає → `{ withDeleted: false }`: типова поведінка — видалений документ не знайдено.
 *
 * Навмисно pipe, а не DTO через `@Query()`: глобальний ValidationPipe має `forbidNonWhitelisted`,
 * і DTO зробив би помилкою 400 будь-який сторонній query-параметр на цих шість маршрутів.
 *
 * Результат — об'єкт, а не `boolean`: для параметра з типом `boolean` глобальний ValidationPipe
 * (`transform: true`) сам перетворює значення ДО цього pipe, і `abc` мовчки стало б `false`.
 *
 * Використання:
 *   `@Query('withDeleted', WithDeletedQueryPipe) opts: WithDeletedOption`
 */
export class WithDeletedQueryPipe implements PipeTransform<unknown, WithDeletedOption> {
  transform(value: unknown): WithDeletedOption {
    if (value === undefined) return { withDeleted: false };
    if (value === 'true') return { withDeleted: true };
    if (value === 'false') return { withDeleted: false };
    throw new BadRequestException({
      statusCode: 400,
      message: [translateError('err.cv.isBooleanString', getLocale(), { field: 'withDeleted' })],
      error: 'Bad Request',
    });
  }
}
