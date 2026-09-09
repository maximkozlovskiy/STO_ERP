import type { ValidationError } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';

/**
 * Maps class-validator constraint keys to Ukrainian messages.
 * Used by global ValidationPipe `exceptionFactory` to localize 400-responses
 * shown to end users in toasts/forms.
 *
 * Generic templates use `{field}` and `{constraint}` placeholders.
 */
const TEMPLATES: Record<string, (field: string, args?: unknown) => string> = {
  // Common
  isNotEmpty: f => `Поле "${f}" не може бути порожнім`,
  isDefined: f => `Поле "${f}" обов'язкове`,
  isOptional: f => `Поле "${f}" має невалідне значення`,

  // Strings
  isString: f => `Поле "${f}" має бути рядком`,
  minLength: f => `Поле "${f}" занадто коротке`,
  maxLength: f => `Поле "${f}" занадто довге`,
  length: f => `Поле "${f}" має некоректну довжину`,
  matches: f => `Поле "${f}" має некоректний формат`,

  // Numbers
  isNumber: f => `Поле "${f}" має бути числом`,
  isInt: f => `Поле "${f}" має бути цілим числом`,
  isPositive: f => `Поле "${f}" має бути додатнім числом`,
  isNegative: f => `Поле "${f}" має бути від'ємним числом`,
  min: f => `Поле "${f}" менше за допустимий мінімум`,
  max: f => `Поле "${f}" більше за допустимий максимум`,

  // Booleans
  isBoolean: f => `Поле "${f}" має бути логічним (true/false)`,
  isBooleanString: f => `Поле "${f}" має бути "true" або "false"`,

  // Specials
  isUuid: f => `Поле "${f}" має бути UUID`,
  isEmail: f => `Поле "${f}" має бути email-адресою`,
  isUrl: f => `Поле "${f}" має бути URL`,
  isIso8601: f => `Поле "${f}" має бути датою у форматі ISO 8601 (YYYY-MM-DD)`,
  isDateString: f => `Поле "${f}" має бути коректною датою`,
  isPhoneNumber: f => `Поле "${f}" має бути номером телефону`,
  isJson: f => `Поле "${f}" має бути валідним JSON`,

  // Enums
  isEnum: f => `Поле "${f}" має одне з допустимих значень`,
  isIn: f => `Поле "${f}" має одне з допустимих значень`,

  // Arrays
  isArray: f => `Поле "${f}" має бути масивом`,
  arrayMinSize: f => `Масив "${f}" містить замало елементів`,
  arrayMaxSize: f => `Масив "${f}" містить забагато елементів`,
  arrayUnique: f => `Масив "${f}" має містити унікальні елементи`,

  // Nested
  nestedValidation: f => `Вкладене поле "${f}" має некоректні значення`,

  // Whitelist
  whitelistValidation: f => `Поле "${f}" недозволене`,
};

/**
 * Translates a single ValidationError leaf (constraints map) to Ukrainian.
 * Falls back to English message if a constraint is unknown.
 */
function translateLeaf(error: ValidationError, parentPath: string[] = []): string[] {
  const path = [...parentPath, error.property];
  const fieldPath = path.join('.');
  const messages: string[] = [];

  if (error.constraints) {
    for (const [key, defaultMessage] of Object.entries(error.constraints)) {
      const tpl = TEMPLATES[key];
      messages.push(tpl ? tpl(fieldPath) : defaultMessage);
    }
  }

  if (error.children?.length) {
    for (const child of error.children) {
      messages.push(...translateLeaf(child, path));
    }
  }

  return messages;
}

/**
 * Global exceptionFactory — receives ValidationError[] from class-validator,
 * returns BadRequestException with Ukrainian, user-facing messages.
 */
export function validationExceptionFactory(errors: ValidationError[]): BadRequestException {
  const messages = errors.flatMap(e => translateLeaf(e));
  return new BadRequestException({
    statusCode: 400,
    message: messages.length > 0 ? messages : ['Помилка валідації'],
    error: 'Bad Request',
  });
}
