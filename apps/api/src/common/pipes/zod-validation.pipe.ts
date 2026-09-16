import { BadRequestException } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import type { ZodSchema, ZodIssue } from 'zod';

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

    const messages = result.error.issues.map(formatIssue);
    throw new BadRequestException({
      statusCode: 400,
      message: messages.length > 0 ? messages : ['Помилка валідації'],
      error: 'Bad Request',
    });
  }
}

/**
 * zod-issue → рядок українською. Повідомлення схеми вже локалізовані (validators.ts), тож
 * беремо `issue.message` як є; шлях поля додаємо префіксом лише коли він інформативний
 * (щоб форма могла зіставити помилку з полем, як у class-validator-факторі «Поле "x" ...»).
 */
function formatIssue(issue: ZodIssue): string {
  const path = issue.path.filter(p => typeof p === 'string' || typeof p === 'number').join('.');
  // Уникнення дублю «Поле "name": Вкажіть назву…» коли меседж уже самодостатній без поля —
  // додаємо префікс лише якщо повідомлення не згадує поле і шлях є.
  if (!path) return issue.message;
  return `${issue.message} (поле "${path}")`;
}
