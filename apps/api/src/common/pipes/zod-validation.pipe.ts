import { BadRequestException } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import type { ZodSchema, ZodIssue } from 'zod';
import { translateValidation, type ValidationLocale } from '@sto/shared';
import { getLocale } from '../tenant/tenant-context';

/**
 * Валідація тіла запиту спільною zod-схемою (packages/shared) — ЄДИНЕ джерело правди з web.
 *
 * Свідомо БЕЗ nestjs-zod: тонкий pipe, що дзеркалить формат помилки глобального
 * `validationExceptionFactory` (common/pipes/validation-error.factory.ts) —
 * `BadRequestException({ statusCode: 400, message: string[], error: 'Bad Request' })` з
 * українськими повідомленнями. Тож контракт відповіді 400 НЕ змінюється: `apiFetch` на web і
 * всі наявні споживачі працюють без змін, незалежно від того, DTO валідовано class-validator
 * чи цим pipe (перехідне співіснування безпечне).
 *
 * Використання: `@Body(new ZodValidationPipe(someFormSchema)) dto: SomeFormValues`.
 * Схема сама коерсить рядкові web-поля (z.coerce/z.preprocess) → повертає типізований об'єкт.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    // i18n: issue.message — це KEY (schemas у @sto/shared емітять ключі). Резолвимо у мову запиту
    // (ALS getLocale(), default 'uk'). Контракт 400 незмінний: { statusCode, message: string[], error }.
    const locale = getLocale();
    const messages = result.error.issues.map(i => formatIssue(i, locale));
    throw new BadRequestException({
      statusCode: 400,
      message: messages.length > 0 ? messages : [translateValidation('v.validationFailed', locale)],
      error: 'Bad Request',
    });
  }
}

/**
 * zod-issue → локалізований рядок. `issue.message` = validation-KEY → translateValidation.
 * Шлях поля додаємо суфіксом (локалізований v.fieldSuffix) лише коли він інформативний
 * (щоб форма могла зіставити помилку з полем, як у class-validator-факторі «Поле "x" ...»).
 */
function formatIssue(issue: ZodIssue, locale: ValidationLocale): string {
  const path = issue.path.filter(p => typeof p === 'string' || typeof p === 'number').join('.');
  const msg = translateValidation(issue.message, locale);
  if (!path) return msg;
  return `${msg} ${translateValidation('v.fieldSuffix', locale, { path })}`;
}
