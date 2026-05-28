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
 * Bug #127/#128: маппінг відомих Prisma error codes у HTTP-статуси.
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
      return { status: HttpStatus.CONFLICT, message: `Запис з таким значенням вже існує (${fields})` };
    }
    case 'P2003':
      // Foreign key constraint violation
      return { status: HttpStatus.BAD_REQUEST, message: 'Порушення зовнішнього ключа: пов\'язаний запис не знайдено' };
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
      return { status: HttpStatus.BAD_REQUEST, message: 'Обов\'язкове поле не може бути порожнім' };
    default:
      return null;
  }
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
      // Bug #127/#128: Prisma помилки конвертуємо у 4xx БЕЗ Sentry alert.
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
      // Validation error — як правило, неправильні дані від клієнта
      status = HttpStatus.BAD_REQUEST;
      message = 'Некоректні дані запиту';
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
