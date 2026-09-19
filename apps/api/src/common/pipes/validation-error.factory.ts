import type { ValidationError } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { translateError, type ValidationLocale } from '@sto/shared';
import { getLocale } from '../tenant/tenant-context';

/**
 * Локалізація class-validator 400-помилок (uk/en). Generic-констрейнти → err.cv.<constraint>-ключі
 * (translateError з getLocale, {{field}}-параметр). Inline @IsX({message:'err.dto.*'})-оверрайди у DTO
 * теж стали ключами → translateLeaf резолвить будь-який рядок-ключ через translateError (fallback
 * locale→uk→сам рядок, тож не-ключ default-message лишається як є). Контракт 400 незмінний.
 *
 * Дзеркалить ZodValidationPipe.formatIssue — обидва шляхи 400 тепер локалізовані однаково.
 */
const CV_TEMPLATE_KEYS: Record<string, string> = {
  isNotEmpty: 'err.cv.isNotEmpty',
  isDefined: 'err.cv.isDefined',
  isOptional: 'err.cv.isOptional',
  isString: 'err.cv.isString',
  minLength: 'err.cv.minLength',
  maxLength: 'err.cv.maxLength',
  length: 'err.cv.length',
  matches: 'err.cv.matches',
  isNumber: 'err.cv.isNumber',
  isInt: 'err.cv.isInt',
  isPositive: 'err.cv.isPositive',
  isNegative: 'err.cv.isNegative',
  min: 'err.cv.min',
  max: 'err.cv.max',
  isBoolean: 'err.cv.isBoolean',
  isBooleanString: 'err.cv.isBooleanString',
  isUuid: 'err.cv.isUuid',
  isEmail: 'err.cv.isEmail',
  isUrl: 'err.cv.isUrl',
  isIso8601: 'err.cv.isIso8601',
  isDateString: 'err.cv.isDateString',
  isPhoneNumber: 'err.cv.isPhoneNumber',
  isJson: 'err.cv.isJson',
  isEnum: 'err.cv.isEnum',
  isIn: 'err.cv.isEnum',
  isArray: 'err.cv.isArray',
  arrayMinSize: 'err.cv.arrayMinSize',
  arrayMaxSize: 'err.cv.arrayMaxSize',
  arrayUnique: 'err.cv.arrayUnique',
  nestedValidation: 'err.cv.nestedValidation',
  whitelistValidation: 'err.cv.whitelistValidation',
};

/**
 * Translates a single ValidationError leaf (constraints map) to the request locale.
 * Generic constraint → err.cv.<key> template with {{field}}. Any other constraint value
 * (a DTO @IsX({message:'err.dto.*'}) override, now a key) is resolved via translateError too;
 * a non-key default-message falls back to itself (fallback chain locale→uk→key).
 */
function translateLeaf(
  error: ValidationError,
  locale: ValidationLocale,
  parentPath: string[] = [],
): string[] {
  const path = [...parentPath, error.property];
  const fieldPath = path.join('.');
  const messages: string[] = [];

  if (error.constraints) {
    for (const [key, defaultMessage] of Object.entries(error.constraints)) {
      const tplKey = CV_TEMPLATE_KEYS[key];
      messages.push(
        tplKey
          ? translateError(tplKey, locale, { field: fieldPath })
          : translateError(defaultMessage, locale, { field: fieldPath }),
      );
    }
  }

  if (error.children?.length) {
    for (const child of error.children) {
      messages.push(...translateLeaf(child, locale, path));
    }
  }

  return messages;
}

/**
 * Global exceptionFactory — receives ValidationError[] from class-validator,
 * returns a localized 400 BadRequestException. Contract shape unchanged.
 */
export function validationExceptionFactory(errors: ValidationError[]): BadRequestException {
  const locale = getLocale();
  const messages = errors.flatMap(e => translateLeaf(e, locale));
  return new BadRequestException({
    statusCode: 400,
    message: messages.length > 0 ? messages : [translateError('v.validationFailed', locale)],
    error: 'Bad Request',
  });
}
