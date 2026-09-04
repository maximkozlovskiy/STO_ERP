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

/**
 * Маппінг відомих Prisma error codes у HTTP-статуси.
 * Без цього мапінгу `prisma.X.findFirst({ where: { id: 'not-uuid' } })`
 * кидає P2023 → потрапляє у "Unhandled exception" гілку → 500 → шум у Sentry.
 *
 * Очікувана клієнтська поведінка: 4xx (400 для bad input, 404 для not-found,
 * 409 для конфлікту унікальності) — БЕЗ відправки у Sentry.
 */
function mapPrismaErrorToHttp(
  e: Prisma.PrismaClientKnownRequestError,
): { status: number; message: string } | null {
  switch (e.code) {
    case 'P2002': {
      // Unique constraint violation
      const target = (e.meta as { target?: string[] } | undefined)?.target;
      const fields = Array.isArray(target) ? target.join(', ') : 'поле';
      return {
        status: HttpStatus.CONFLICT,
        message: `Запис з таким значенням вже існує (${fields})`,
      };
    }
    case 'P2003':
      // Foreign key constraint violation
      return {
        status: HttpStatus.BAD_REQUEST,
        message: "Порушення зовнішнього ключа: пов'язаний запис не знайдено",
      };
    case 'P2025':
      // Record not found in update/delete
      return { status: HttpStatus.NOT_FOUND, message: 'Запис не знайдено' };
    case 'P2023':
      // Inconsistent column data (e.g. invalid UUID)
      return { status: HttpStatus.BAD_REQUEST, message: 'Некоректний формат ідентифікатора' };
    case 'P2000':
      // Value too long for column
      return { status: HttpStatus.BAD_REQUEST, message: 'Значення занадто довге для поля' };
    case 'P2011':
      // Null constraint violation
      return { status: HttpStatus.BAD_REQUEST, message: "Обов'язкове поле не може бути порожнім" };
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

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Внутрішня помилка сервера';

    if (exception instanceof HttpException) {
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
        message = mapped.message;
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
      message = 'Некоректні дані запиту';
      const firstLine = String(exception.message ?? '')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .pop(); // Prisma кладе фактичну причину у ОСТАННІЙ непорожній рядок
      this.logger.warn(
        `PrismaClientValidationError on ${request.method} ${request.url}: ${firstLine ?? '(no message)'}`,
      );
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
      message = 'Некоректний запит: перевірте тіло та Content-Type';
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
