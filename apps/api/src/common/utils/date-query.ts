import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { getLocale } from '../tenant/tenant-context';
import { isCalendarDate } from './kyiv-date';

/**
 * Перевірка дат відбору, що приходять query-параметрами БЕЗ DTO (`@Query('dateFrom')`).
 *
 * Без неї сміття давало `Invalid Date` і безіменну відмову Prisma, а неіснуюча дата
 * (`2026-02-31`) мовчки «перекочувалась» у березень — список відбирався за іншим днем, ніж
 * просив користувач. Порожнє значення — «межі немає», не помилка. Не-рядок (повторений
 * параметр `?dateFrom=a&dateFrom=b` приходить масивом) — помилка.
 */
export function assertCalendarDateQuery(...values: unknown[]): void {
  for (const value of values) {
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || !isCalendarDate(value))
      throw new BadRequestException(translateError('err.list.invalidDateFilter', getLocale()));
  }
}
