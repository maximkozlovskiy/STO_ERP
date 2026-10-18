import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../prisma/prisma.service';
import { memoryTable } from '../../cash/cash.spec-fixture';
import type { DeadLetterService } from '../../dead-letter/dead-letter.service';
import { IntegrationLogService } from '../../integration-logs/integration-log.service';
import { SupplierAdapterRegistry } from '../adapters/supplier-adapter-registry';
import type { SupplierAdapter } from '../adapters/supplier-adapter.interface';
import {
  SupplierAuthError,
  SupplierNetworkError,
  SupplierRateLimitError,
} from '../http/supplier-errors';
import { CONN, ORG, SUPPLIER_CP } from '../supplier-api.spec-fixture';
import { SupplierSearchProcessor } from './supplier-search.processor';

/** Обробник `verify` (BR-SCON-004, 006, 007): результат пише обробник, ліміт не витрачає спробу. */
function setup(verify: () => Promise<void>) {
  const supplierConnection = memoryTable([
    {
      id: CONN,
      orgId: ORG,
      counterpartyId: SUPPLIER_CP,
      provider: 'AVD_TRADE',
      apiUrl: null,
      testMode: false,
      credentials: '{"apiKey":"k"}',
      options: {},
      verifyStatus: 'PENDING',
      lastVerifiedAt: null,
      lastError: null,
      deletedAt: null,
    },
  ]);
  const integrationLog = memoryTable([]);
  const prisma = { supplierConnection, integrationLog } as unknown as PrismaService;
  const adapter = { provider: 'AVD_TRADE', verify: vi.fn(verify) } as unknown as SupplierAdapter;
  const proc = new SupplierSearchProcessor(
    prisma,
    new SupplierAdapterRegistry([adapter]),
    new IntegrationLogService(prisma),
    {} as never, // пошук пропозицій тут не викликається
    { capture: vi.fn() } as unknown as DeadLetterService,
  );
  const row = supplierConnection.rows[0];
  return { proc, row, integrationLog };
}

const job = (attemptsMade = 0) => {
  const j = {
    name: 'verify',
    data: { orgId: ORG, connectionId: CONN },
    attemptsMade,
    opts: { attempts: 10, backoff: { type: 'exponential', delay: 30_000 } },
    moveToDelayed: vi.fn(() => Promise.resolve()),
  };
  return j as unknown as Job & { moveToDelayed: ReturnType<typeof vi.fn> };
};

describe('SupplierSearchProcessor.verify', () => {
  // guards: BR-SCON-004
  it('успіх → OK і lastVerifiedAt; обмін записано в журнал інтеграцій', async () => {
    const { proc, row, integrationLog } = setup(() => Promise.resolve());
    await proc.process(job());
    expect(row.verifyStatus).toBe('OK');
    expect(row.lastVerifiedAt).toBeInstanceOf(Date);
    await new Promise(r => setTimeout(r, 0));
    expect(integrationLog.rows[0]).toMatchObject({
      provider: 'AVD_TRADE',
      operation: 'verify',
      ok: true,
    });
  });

  // guards: BR-SCON-006
  it('невірні креди → FAILED з причиною і UnrecoverableError (без повторів)', async () => {
    const { proc, row } = setup(() =>
      Promise.reject(new SupplierAuthError('AVD', 'AVD 401: Немає / невалідний ключ.', 401)),
    );
    await expect(proc.process(job())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(row).toMatchObject({
      verifyStatus: 'FAILED',
      lastError: 'AVD 401: Немає / невалідний ключ.',
    });
  });

  // guards: BR-SCON-006
  it('мережа: не остання спроба — повтор, рядок лишається PENDING; остання — FAILED', async () => {
    const { proc, row } = setup(() =>
      Promise.reject(new SupplierNetworkError('AVD', "AVD: немає зв'язку", false)),
    );
    await expect(proc.process(job(3))).rejects.toBeInstanceOf(SupplierNetworkError);
    expect(row.verifyStatus).toBe('PENDING');
    await expect(proc.process(job(9))).rejects.toBeInstanceOf(SupplierNetworkError);
    expect(row.verifyStatus).toBe('FAILED');
  });

  // guards: BR-SCON-007
  it('ліміт → задача відкладається до скидання квоти (moveToDelayed + DelayedError), FAILED не ставиться', async () => {
    const { proc, row } = setup(() =>
      Promise.reject(new SupplierRateLimitError('AVD', 'AVD 429', 45_000)),
    );
    const j = job(9);
    const before = Date.now();
    await expect(proc.process(j, 'tok')).rejects.toBeInstanceOf(DelayedError);
    const [at, token] = j.moveToDelayed.mock.calls[0] as [number, string];
    expect(at).toBeGreaterThanOrEqual(before + 45_000);
    expect(token).toBe('tok');
    expect(row.verifyStatus).toBe('PENDING');
  });

  it('видалене підключення — тихо нічого', async () => {
    const { proc, row } = setup(() => Promise.reject(new Error('не має викликатись')));
    row.deletedAt = new Date();
    await expect(proc.process(job())).resolves.toBeUndefined();
  });
});
