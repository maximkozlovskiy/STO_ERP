import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntegrationLogService, IntegrationLogContext } from './integration-log.service';

/**
 * wrap() — єдиний seam логування зовнішніх обмінів. Критично:
 *  - control flow незмінний (re-throw на помилці, повертає результат на успіху);
 *  - лог fire-and-forget (create кидає → wrap НЕ кидає, операція не зривається);
 *  - httpStatus парситься з error-тексту; секрети НЕ потрапляють у data.
 */
describe('IntegrationLogService.wrap', () => {
  let service: IntegrationLogService;
  let create: ReturnType<typeof vi.fn>;
  const ctx: IntegrationLogContext = {
    orgId: 'org-1',
    branchId: 'br-1',
    provider: 'monobank',
    operation: 'getStatus',
    documentType: 'OnlinePaymentIntent',
    documentId: 'doc-1',
  };

  beforeEach(() => {
    create = vi.fn().mockResolvedValue({});
    const prisma = { integrationLog: { create } } as never;
    service = new IntegrationLogService(prisma);
  });

  it('успіх → повертає результат fn + пише ok:true з durationMs', async () => {
    const r = await service.wrap(ctx, async () => 'RESULT');
    expect(r).toBe('RESULT');
    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect(data.ok).toBe(true);
    expect(data.httpStatus).toBeNull();
    expect(typeof data.durationMs).toBe('number');
    expect(data.provider).toBe('monobank');
    expect(data.operation).toBe('getStatus');
    expect(data.documentType).toBe('OnlinePaymentIntent');
    expect(data.documentId).toBe('doc-1');
  });

  it('помилка → RE-THROW (control flow незмінний) + пише ok:false', async () => {
    const err = new Error('monobank 502: Bad Gateway');
    await expect(service.wrap(ctx, async () => Promise.reject(err))).rejects.toBe(err);
    const data = create.mock.calls[0][0].data;
    expect(data.ok).toBe(false);
    expect(data.httpStatus).toBe(502); // парсинг з тексту
    expect(data.error).toContain('502');
  });

  it('httpStatus: без 3-значного статусу у тексті → null', async () => {
    await service
      .wrap(ctx, async () => Promise.reject(new Error('timeout aborted')))
      .catch(() => undefined);
    expect(create.mock.calls[0][0].data.httpStatus).toBeNull();
  });

  it('httpStatus: парсить лише 1xx-5xx (не довільне число)', async () => {
    await service
      .wrap(ctx, async () => Promise.reject(new Error('Вчасно 999: щось')))
      .catch(() => undefined);
    // 999 не у [1-5]\d\d → null (уникаємо хибних «статусів» типу id/сум)
    expect(create.mock.calls[0][0].data.httpStatus).toBeNull();
  });

  it('error truncate до 500 символів', async () => {
    const long = 'x'.repeat(2000);
    await service.wrap(ctx, async () => Promise.reject(new Error(long))).catch(() => undefined);
    expect(create.mock.calls[0][0].data.error.length).toBe(500);
  });

  it('fire-and-forget: create кидає → wrap НЕ зриває успіх (лог не критичний)', async () => {
    create.mockRejectedValue(new Error('DB down'));
    // не має кинути — результат операції проходить попри збій логу
    await expect(service.wrap(ctx, async () => 'OK')).resolves.toBe('OK');
  });

  it('fire-and-forget: create кидає на error-шляху → оригінальна помилка все одно re-throw', async () => {
    create.mockRejectedValue(new Error('DB down'));
    const orig = new Error('provider fail');
    await expect(service.wrap(ctx, async () => Promise.reject(orig))).rejects.toBe(orig);
  });

  it('secret-hygiene: data містить ЛИШЕ whitelist-поля (без credentials/token/apiKey)', async () => {
    await service.wrap(ctx, async () => 'OK');
    const data = create.mock.calls[0][0].data;
    const keys = Object.keys(data).sort();
    expect(keys).toEqual(
      [
        'branchId',
        'documentId',
        'documentType',
        'durationMs',
        'error',
        'httpStatus',
        'ok',
        'operation',
        'orgId',
        'provider',
      ].sort(),
    );
    // жодного секрет-ключа
    for (const k of keys) {
      expect(/credential|token|apikey|secret|signature|password/i.test(k)).toBe(false);
    }
  });

  it('мінімальний ctx (без branchId/document) → null-и, без падіння', async () => {
    await service.wrap(
      { orgId: 'o', provider: 'liqpay', operation: 'verifyCredentials' },
      async () => 1,
    );
    const data = create.mock.calls[0][0].data;
    expect(data.branchId).toBeNull();
    expect(data.documentType).toBeNull();
    expect(data.documentId).toBeNull();
  });
});

// Pre-prod audit R2: date-фільтри беруться сирими рядками (@Query) → invalid дата має давати
// чистий 400, НЕ Prisma-500 (Bug #595 class).
describe('IntegrationLogService.findAll — date validation', () => {
  let service: IntegrationLogService;
  let findMany: ReturnType<typeof vi.fn>;
  let count: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findMany = vi.fn().mockResolvedValue([]);
    count = vi.fn().mockResolvedValue(0);
    const prisma = { integrationLog: { findMany, count } } as never;
    service = new IntegrationLogService(prisma);
  });

  it('invalid dateFrom → BadRequest (не 500), findMany НЕ викликано', async () => {
    const { BadRequestException } = await import('@nestjs/common');
    await expect(
      service.findAll('org-1', 1, 50, undefined, undefined, undefined, undefined, 'abc'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('invalid dateTo → BadRequest', async () => {
    const { BadRequestException } = await import('@nestjs/common');
    await expect(
      service.findAll('org-1', 1, 50, undefined, undefined, undefined, undefined, undefined, 'xyz'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('валідні дати → фільтр застосовано (gte/lte у where.createdAt)', async () => {
    await service.findAll(
      'org-1',
      1,
      50,
      undefined,
      undefined,
      undefined,
      undefined,
      '2026-09-01',
      '2026-09-08',
    );
    const where = findMany.mock.calls[0][0].where;
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lte).toBeInstanceOf(Date);
  });

  it('без дат → без createdAt-фільтра', async () => {
    await service.findAll('org-1');
    expect(findMany.mock.calls[0][0].where.createdAt).toBeUndefined();
  });
});
