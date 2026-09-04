import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpExceptionFilter } from './http-exception.filter';

/** Створює мок ArgumentsHost для unit-тестування фільтра. */
function makeHost(method = 'GET', url = '/api/test') {
  const reply = { status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
  const request = { method, url };
  const host = {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { host, reply, request };
}

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
  });

  describe('HttpException — стандартна поведінка', () => {
    it('NotFoundException → 404 з оригінальним повідомленням', () => {
      const { host, reply } = makeHost();
      filter.catch(new NotFoundException("Об'єкт не знайдено"), host);

      expect(reply.status).toHaveBeenCalledWith(404);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 404, message: "Об'єкт не знайдено" }),
      );
    });

    it('BadRequestException → 400 з повідомленням', () => {
      const { host, reply } = makeHost();
      filter.catch(new BadRequestException('Некоректні дані'), host);

      expect(reply.status).toHaveBeenCalledWith(400);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 400, message: 'Некоректні дані' }),
      );
    });

    it("масив повідомлень з validation pipe з'єднується через ; ", () => {
      const { host, reply } = makeHost();
      const ex = new HttpException({ message: ['поле1 порожнє', 'поле2 неправильне'] }, 400);
      filter.catch(ex, host);

      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'поле1 порожнє; поле2 неправильне' }),
      );
    });
  });

  describe('Prisma errors — Bug #127/#128', () => {
    it('P2023 (malformed UUID) → 400 "Некоректний формат ідентифікатора"', () => {
      const { host, reply } = makeHost('GET', '/api/branches/not-uuid');
      const p2023 = new Prisma.PrismaClientKnownRequestError('Inconsistent column data', {
        code: 'P2023',
        clientVersion: '5.0.0',
      });
      filter.catch(p2023, host);

      expect(reply.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          message: 'Некоректний формат ідентифікатора',
          path: '/api/branches/not-uuid',
        }),
      );
    });

    it('P2025 (record not found) → 404 "Запис не знайдено"', () => {
      const { host, reply } = makeHost('PATCH', '/api/work-orders/123');
      const p2025 = new Prisma.PrismaClientKnownRequestError('Record to update not found', {
        code: 'P2025',
        clientVersion: '5.0.0',
      });
      filter.catch(p2025, host);

      expect(reply.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 404, message: 'Запис не знайдено' }),
      );
    });

    it('P2002 (unique constraint) → 409 з полями target', () => {
      const { host, reply } = makeHost('POST', '/api/employees');
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['email'] },
      });
      filter.catch(p2002, host);

      expect(reply.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 409, message: expect.stringContaining('email') }),
      );
    });

    it('P2003 (foreign key) → 400', () => {
      const { host, reply } = makeHost();
      const p2003 = new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
        code: 'P2003',
        clientVersion: '5.0.0',
      });
      filter.catch(p2003, host);

      expect(reply.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          message: expect.stringContaining('зовнішнього ключа'),
        }),
      );
    });

    it('P2000 (value too long) → 400', () => {
      const { host, reply } = makeHost();
      const p2000 = new Prisma.PrismaClientKnownRequestError('Value too long', {
        code: 'P2000',
        clientVersion: '5.0.0',
      });
      filter.catch(p2000, host);

      expect(reply.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    });

    it('P2011 (null constraint) → 400', () => {
      const { host, reply } = makeHost();
      const p2011 = new Prisma.PrismaClientKnownRequestError('Null constraint', {
        code: 'P2011',
        clientVersion: '5.0.0',
      });
      filter.catch(p2011, host);

      expect(reply.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    });

    it('PrismaClientValidationError → 400 "Некоректні дані запиту"', () => {
      const { host, reply } = makeHost();
      const ve = new Prisma.PrismaClientValidationError('Invalid args', { clientVersion: '5.0.0' });
      filter.catch(ve, host);

      expect(reply.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 400, message: 'Некоректні дані запиту' }),
      );
    });

    // Bug #618: PrismaClientValidationError теж має логуватися — інакше причина
    // Prisma-помилки залишається невидимою (див. Bug #617 у BUG_REPORT.md).
    it('Bug #618: PrismaClientValidationError логується як warn з останнім рядком повідомлення', () => {
      const { host } = makeHost('POST', '/api/reports/builder/run');
      const warnSpy = vi
        .spyOn((filter as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      const ve = new Prisma.PrismaClientValidationError(
        'Some header line\n\nPlease either use `include` or `select`, but not both at the same time',
        { clientVersion: '5.0.0' },
      );
      filter.catch(ve, host);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = warnSpy.mock.calls[0][0];
      expect(msg).toContain('POST /api/reports/builder/run');
      expect(msg).toContain('Please either use `include` or `select`');
    });

    it('невідомий Prisma код → 500 (без падіння filter)', () => {
      const { host, reply } = makeHost();
      const unknown = new Prisma.PrismaClientKnownRequestError('Unknown', {
        code: 'P9999' as never,
        clientVersion: '5.0.0',
      });
      filter.catch(unknown, host);

      expect(reply.status).toHaveBeenCalledWith(500);
    });
  });

  describe('Bug #627: Fastify content-type-parser помилки → 4xx (не 500)', () => {
    it('FST_ERR_CTP_EMPTY_JSON_BODY (bodyless POST + application/json) → 400 без Sentry', () => {
      const { host, reply } = makeHost('POST', '/api/goods/abc/restore');
      const warnSpy = vi
        .spyOn((filter as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      const errorSpy = vi
        .spyOn((filter as unknown as { logger: { error: (msg: string) => void } }).logger, 'error')
        .mockImplementation(() => undefined);
      const fastifyErr = Object.assign(
        new Error("Body cannot be empty when content-type is set to 'application/json'"),
        { code: 'FST_ERR_CTP_EMPTY_JSON_BODY', statusCode: 400 },
      );
      filter.catch(fastifyErr, host);

      expect(reply.status).toHaveBeenCalledWith(400);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          message: expect.stringContaining('Некоректний запит'),
        }),
      );
      // warn (не error) → без Sentry-шуму
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('FST_ERR_CTP_INVALID_MEDIA_TYPE (415) → зберігає свій statusCode', () => {
      const { host, reply } = makeHost('POST', '/api/goods');
      const fastifyErr = Object.assign(new Error('Unsupported Media Type'), {
        code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE',
        statusCode: 415,
      });
      filter.catch(fastifyErr, host);

      expect(reply.status).toHaveBeenCalledWith(415);
    });

    it('FastifyError з 5xx statusCode → лишається 500 (справжній серверний збій)', () => {
      const { host, reply } = makeHost('POST', '/api/goods');
      const fastifyErr = Object.assign(new Error('Internal parser failure'), {
        code: 'FST_ERR_CTP_BODY_TOO_LARGE',
        statusCode: 500,
      });
      filter.catch(fastifyErr, host);

      // guard вимагає 4xx → 5xx падає у Unhandled гілку (500)
      expect(reply.status).toHaveBeenCalledWith(500);
    });

    it('звичайний Error з code що НЕ FST_ERR_CTP_* → 500 (не плутати з Node errno)', () => {
      const { host, reply } = makeHost();
      const nodeErr = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
        statusCode: 400,
      });
      filter.catch(nodeErr, host);

      expect(reply.status).toHaveBeenCalledWith(500);
    });
  });

  describe('Unhandled exceptions', () => {
    it('звичайний Error → 500 з generic повідомленням', () => {
      const { host, reply } = makeHost();
      filter.catch(new Error('System failure'), host);

      expect(reply.status).toHaveBeenCalledWith(500);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 500, message: 'Внутрішня помилка сервера' }),
      );
    });

    it('non-Error (string) → 500', () => {
      const { host, reply } = makeHost();
      filter.catch('plain string error', host);

      expect(reply.status).toHaveBeenCalledWith(500);
    });
  });
});
