import { describe, it, expect, vi } from 'vitest';
import { CORRELATION_ID_HEADER, CorrelationIdMiddleware } from './correlation-id.middleware';

// Loose v1-v5 UUID layout used as a known-valid value across tests.
const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const ANOTHER_VALID = '7b4e9c0a-1234-5678-9abc-def012345678';

type MockReq = { headers: Record<string, string | string[] | undefined> };
type MockRes = { setHeader: ReturnType<typeof vi.fn> };

function mkReq(headers: Record<string, string | string[] | undefined> = {}): MockReq {
  return { headers };
}
function mkRes(): MockRes {
  return { setHeader: vi.fn() };
}

describe('CorrelationIdMiddleware', () => {
  it('генерує новий UUID коли inbound заголовок відсутній', () => {
    const mw = new CorrelationIdMiddleware();
    const req = mkReq();
    const res = mkRes();
    const next = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw.use(req as any, res as any, next);

    const id = req.headers[CORRELATION_ID_HEADER];
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[a-zA-Z0-9-]{36}$/); // randomUUID() формат
    expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, id);
    expect(next).toHaveBeenCalledOnce();
  });

  it('echo-ить inbound заголовок коли він валідний', () => {
    const mw = new CorrelationIdMiddleware();
    const req = mkReq({ [CORRELATION_ID_HEADER]: VALID_UUID });
    const res = mkRes();
    const next = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw.use(req as any, res as any, next);

    expect(req.headers[CORRELATION_ID_HEADER]).toBe(VALID_UUID);
    expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, VALID_UUID);
    expect(next).toHaveBeenCalledOnce();
  });

  it('генерує новий UUID коли inbound заголовок невалідний (XSS-like content)', () => {
    const mw = new CorrelationIdMiddleware();
    const req = mkReq({ [CORRELATION_ID_HEADER]: '<script>alert(1)</script>' });
    const res = mkRes();
    const next = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw.use(req as any, res as any, next);

    const id = req.headers[CORRELATION_ID_HEADER];
    expect(typeof id).toBe('string');
    expect(id).not.toBe('<script>alert(1)</script>');
    expect(id).toMatch(/^[a-zA-Z0-9-]{36}$/);
    expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, id);
  });

  it('відхиляє надмірно довгий inbound заголовок (>128 chars) і генерує новий UUID', () => {
    const mw = new CorrelationIdMiddleware();
    const huge = 'a'.repeat(129);
    const req = mkReq({ [CORRELATION_ID_HEADER]: huge });
    const res = mkRes();
    const next = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw.use(req as any, res as any, next);

    expect(req.headers[CORRELATION_ID_HEADER]).not.toBe(huge);
    expect((req.headers[CORRELATION_ID_HEADER] as string).length).toBeLessThanOrEqual(128);
  });

  it('бере перший елемент array-form inbound заголовка якщо він валідний', () => {
    const mw = new CorrelationIdMiddleware();
    const req = mkReq({ [CORRELATION_ID_HEADER]: [VALID_UUID, ANOTHER_VALID] });
    const res = mkRes();
    const next = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw.use(req as any, res as any, next);

    expect(req.headers[CORRELATION_ID_HEADER]).toBe(VALID_UUID);
    expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, VALID_UUID);
  });

  it('генерує новий UUID якщо перший елемент array-form невалідний', () => {
    const mw = new CorrelationIdMiddleware();
    const req = mkReq({ [CORRELATION_ID_HEADER]: ['<bad>', VALID_UUID] });
    const res = mkRes();
    const next = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw.use(req as any, res as any, next);

    expect(req.headers[CORRELATION_ID_HEADER]).not.toBe('<bad>');
    expect(req.headers[CORRELATION_ID_HEADER]).not.toBe(VALID_UUID);
    expect(req.headers[CORRELATION_ID_HEADER]).toMatch(/^[a-zA-Z0-9-]{36}$/);
  });

  it('приймає короткий alphanumeric id (e.g. nginx X-Request-Id)', () => {
    const mw = new CorrelationIdMiddleware();
    const req = mkReq({ [CORRELATION_ID_HEADER]: 'abc123_DEF-xyz' });
    const res = mkRes();
    const next = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw.use(req as any, res as any, next);

    expect(req.headers[CORRELATION_ID_HEADER]).toBe('abc123_DEF-xyz');
    expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, 'abc123_DEF-xyz');
  });

  it('викликає next() рівно один раз у всіх кейсах', () => {
    const mw = new CorrelationIdMiddleware();
    const req = mkReq();
    const res = mkRes();
    const next = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw.use(req as any, res as any, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
