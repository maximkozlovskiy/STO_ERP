import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { translateError, type ValidationLocale } from '@sto/shared';
import { TenantIsolationError } from '../../prisma/tenant-isolation.error';
import { getLocale } from '../tenant/tenant-context';

/**
 * Маппінг відомих Prisma error codes у HTTP-статуси.
 * Без цього мапінгу `prisma.X.findFirst({ where: { id: 'not-uuid' } })`
 * кидає P2023 → потрапляє у "Unhandled exception" гілку → 500 → шум у Sentry.
 *
 * Очікувана клієнтська поведінка: 4xx (400 для bad input, 404 для not-found,
 * 409 для конфлікту унікальності) — БЕЗ відправки у Sentry.
 */
/**
 * Prisma error code → HTTP-статус + i18n-KEY (+params). Локалізується у catch() через translateError
 * (getLocale з tenant-ALS). Без мапінгу `findFirst({where:{id:'not-uuid'}})` → P2023 → 500 + Sentry-шум.
 */
function mapPrismaErrorToHttp(
  e: Prisma.PrismaClientKnownRequestError,
): { status: number; key: string; params?: Record<string, string> } | null {
  switch (e.code) {
    case 'P2002': {
      const target = (e.meta as { target?: string[] } | undefined)?.target;
      const fields = Array.isArray(target) ? target.join(', ') : 'поле';
      return { status: HttpStatus.CONFLICT, key: 'err.prisma.unique', params: { fields } };
    }
    case 'P2003':
      return { status: HttpStatus.BAD_REQUEST, key: 'err.prisma.foreignKey' };
    case 'P2025':
      return { status: HttpStatus.NOT_FOUND, key: 'err.prisma.notFound' };
    case 'P2023':
      return { status: HttpStatus.BAD_REQUEST, key: 'err.prisma.badId' };
    case 'P2000':
      return { status: HttpStatus.BAD_REQUEST, key: 'err.prisma.tooLong' };
    case 'P2011':
      return { status: HttpStatus.BAD_REQUEST, key: 'err.prisma.nullConstraint' };
    default:
      return null;
  }
}

/**
 * Fastify-рівнева помилка розбору запиту (FastifyError). Ловимо ТІЛЬКИ ті, що несуть
 * клієнтський 4xx `statusCode` і `code` починається з `FST_ERR_CTP_` (content-type-parser:
 * порожнє тіло, malformed JSON, непідтримуваний media type). Не чіпаємо 5xx-FastifyError
 * (справжні серверні збої) — вони мають лишатись 500 + Sentry.
 */
function isFastifyClientError(
  e: unknown,
): e is { code: string; statusCode: number; message: string } {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  const statusCode = (e as { statusCode?: unknown }).statusCode;
  return (
    typeof code === 'string' &&
    code.startsWith('FST_ERR_CTP_') &&
    typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500
  );
}

/**
 * @fastify/multipart кидає `RequestFileTooLargeError` (code `FST_REQ_FILE_TOO_LARGE`, 413) ПРИ
 * перевищенні `limits.fileSize` — помилка спливає з `file.toBuffer()` у контролері, тобто ПОЗА
 * try/catch хелпера `getUploadedFile` (той ловить лише `req.file()`). Без цієї гілки вона падала у
 * фінальний `else` → generic 500 + шум у Sentry. Веб блокує розмір ДО відправки, але mobile/sync/
 * прямий API такого guard не мають — сервер має бути стійким незалежно від клієнта (клас Bug #627).
 */
function isFastifyFileTooLarge(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  return (e as { code?: unknown }).code === 'FST_REQ_FILE_TOO_LARGE';
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const locale: ValidationLocale = getLocale();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    // Власні строки фільтра — через i18n-KEY (translateError у кінці). HttpException-гілка з сервісу
    // передає вже-рендерений `message` (сервісні throw-и локалізуються окремими батчами).
    let message = translateError('err.internal', locale);

    if (exception instanceof TenantIsolationError) {
      // A1: забутий tenant-фільтр на tenant-моделі — це СЕРВЕРНИЙ баг (не client-error). Логуємо
      // повну діагностику (model+operation — НІКОЛИ where/data: PII/секрети), клієнту generic 500.
      this.logger.error(
        `TenantIsolationError: ${exception.operation} на ${exception.model} без tenant-фільтра — ${request.method} ${request.url}`,
        exception.stack,
      );
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = translateError('err.internal', locale);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'object' && response !== null && 'message' in response) {
        const msg = (response as { message: string | string[] }).message;
        message = Array.isArray(msg) ? msg.join('; ') : msg;
      } else {
        message = exception.message;
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // Prisma помилки конвертуємо у 4xx БЕЗ Sentry alert (P2002 = conflict, P2025 = not found)
      const mapped = mapPrismaErrorToHttp(exception);
      if (mapped) {
        status = mapped.status;
        message = translateError(mapped.key, locale, mapped.params);
      } else {
        // Невідомий Prisma код — лишаємо як 500, але логуємо для діагностики.
        this.logger.error(
          `Unhandled Prisma error ${exception.code} on ${request.method} ${request.url}`,
          exception.stack,
        );
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      // Validation error — фактично ЗАВЖДИ помилка серверного білдера-запитів
      // (клієнт передає лише DTO-whitelisted поля). Bug #618: попередньо ковтали
      // exception.message → 15 хв діагностики Bug #617 замість 1 хв на "Please either
      // use `include` or `select`, but not both at the same time". Тепер логуємо `warn`
      // із першим рядком повідомлення Prisma (без stack — не критично, не 500).
      status = HttpStatus.BAD_REQUEST;
      message = translateError('err.badRequest', locale);
      const firstLine = String(exception.message ?? '')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .pop(); // Prisma кладе фактичну причину у ОСТАННІЙ непорожній рядок
      this.logger.warn(
        `PrismaClientValidationError on ${request.method} ${request.url}: ${firstLine ?? '(no message)'}`,
      );
    } else if (isFastifyFileTooLarge(exception)) {
      // Перевищено ліміт розміру завантаження → чистий 413 українською, БЕЗ Sentry alert.
      status = HttpStatus.PAYLOAD_TOO_LARGE;
      message = translateError('err.requestFileTooLarge', locale);
      this.logger.warn(`File too large on ${request.method} ${request.url}`);
    } else if (isFastifyClientError(exception)) {
      // Bug #627: Fastify content-type-parser / request помилки (FST_ERR_CTP_*) —
      // напр. `Body cannot be empty when content-type is set to 'application/json'`
      // для bodyless POST (/transition, /restore) з заголовком Content-Type: application/json,
      // або malformed JSON. Fastify кидає FastifyError зі своїм `statusCode` (4xx) ДО хендлера,
      // тож він не є HttpException → раніше провалювався у 500 «Внутрішня помилка сервера»
      // + шум у Sentry. Мапимо у чистий 4xx БЕЗ Sentry alert (як Prisma-коди вище).
      // Веб-клієнт вже не шле Content-Type без тіла (api-client.ts), але сервер має бути
      // стійким незалежно від клієнта (mobile/sync/зовнішні інтеграції).
      status = exception.statusCode;
      message = translateError('err.fastifyBadRequest', locale);
      this.logger.warn(
        `Fastify request error ${exception.code} on ${request.method} ${request.url}`,
      );
    } else {
      // Unhandled (non-HTTP) exception — завжди 500
      this.logger.error(
        `Unhandled exception on ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    reply.status(status).send({
      statusCode: status,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
