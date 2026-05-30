import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

export const CORRELATION_ID_HEADER = 'x-request-id';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: FastifyRequest['raw'], res: FastifyReply['raw'], next: () => void): void {
    const existing = (req.headers as Record<string, string | undefined>)[CORRELATION_ID_HEADER];
    const requestId = existing ?? randomUUID();
    (req.headers as Record<string, string>)[CORRELATION_ID_HEADER] = requestId;
    (res as NodeJS.WritableStream & { setHeader?: (k: string, v: string) => void }).setHeader?.(
      CORRELATION_ID_HEADER,
      requestId,
    );
    next();
  }
}
