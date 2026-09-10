/**
 * Кидається tenant-guard-екстеншеном ([tenant-guard.extension.ts]), коли запит на tenant-scoped
 * модель виконано БЕЗ orgId/branchId-фільтра (A1 — fail-closed tenant isolation).
 *
 * Несе лише `model` + `operation` — НІКОЛИ args/where/data (можуть містити PII/секрети). Це серверний
 * баг (забутий tenant-фільтр), не client-error: HttpExceptionFilter логує деталі server-side і повертає
 * клієнту generic 500.
 */
export class TenantIsolationError extends Error {
  constructor(
    public readonly model: string,
    public readonly operation: string,
  ) {
    super(
      `Порушення ізоляції орендаря: ${operation} на моделі ${model} виконано без tenant-фільтра (orgId/branchId)`,
    );
    this.name = 'TenantIsolationError';
  }
}
