import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

export const CORRELATION_ID_HEADER = 'x-request-id';

// Loose correlation-id format: printable ASCII, alphanumeric + `-_`, max 128 chars.
// Rejects multi-line strings, control chars, unbounded payloads — defends against
// log-injection and log-bloat via attacker-controlled header.
const CORRELATION_ID_RE = /^[a-zA-Z0-9-_]{1,128}$/;

/**
 * Correlation-ID middleware.
 *
 * Contract:
 *   1. If inbound request carries a valid `x-request-id` header → reuse it.
 *   2. Otherwise → generate a fresh UUID.
 *   3. Echo the chosen id back on `x-request-id` response header.
 *   4. Normalize `req.headers['x-request-id']` so downstream code (including
 *      pino-http's `genReqId`) reads the SAME id.
 *
 * Order note: pino-http runs as a Fastify `onRequest` hook BEFORE Nest middleware.
 * For pino's `req.id` to match this header, `pinoHttp.genReqId` (configured in
 * `app.module.ts`) reads the same header with the same validation regex.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: FastifyRequest['raw'], res: FastifyReply['raw'], next: () => void): void {
    const headers = req.headers as Record<string, string | string[] | undefined>;
    const raw = headers[CORRELATION_ID_HEADER];
    // Handle accidental array form (duplicate inbound header) — take first entry.
    const candidate = Array.isArray(raw) ? raw[0] : raw;
    const isValid = typeof candidate === 'string' && CORRELATION_ID_RE.test(candidate);
    const requestId = isValid ? candidate : randomUUID();

    headers[CORRELATION_ID_HEADER] = requestId;
    (res as NodeJS.WritableStream & { setHeader?: (k: string, v: string) => void }).setHeader?.(
      CORRELATION_ID_HEADER,
      requestId,
    );
    next();
  }
}
