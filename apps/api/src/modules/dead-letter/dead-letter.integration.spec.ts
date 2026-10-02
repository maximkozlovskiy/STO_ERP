import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { withTenantGuard } from '../../prisma/tenant-guard.extension';
import { DeadLetterService } from './dead-letter.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { handleDbUnavailable } from '../../common/testing/require-db';

/**
 * ІНТЕГРАЦІЙНИЙ тест DLQ-writer проти ЖИВОЇ dev-БД: перевіряє, що `capture` пише DeadLetterJob
 * ЧЕРЕЗ tenant-guard $extends БЕЗ ambient tenant-контексту (як у реальному BullMQ failed-listener) —
 * тобто TENANT_EXEMPT('DeadLetterJob') + runUnscoped справді дозволяють запис, а не кидають
 * TenantIsolationError. Юніт-тест (service.spec) мокає Prisma → реальний guard там не виконується.
 *
 * Якщо БД недоступна — SKIP (не фейлить CI без docker).
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://sto:sto_dev_secret@localhost:5432/sto_erp';

let raw: PrismaClient;
let guarded: PrismaClient;
let service: DeadLetterService;
let dbAvailable = false;
const BULL_JOB_ID = `test-dlq-${Date.now()}`;

function fakeJob(over: Record<string, unknown> = {}) {
  return {
    id: BULL_JOB_ID,
    name: 'test-job',
    data: {},
    attemptsMade: 10,
    opts: { attempts: 10 },
    failedReason: 'integration boom',
    stacktrace: ['at test'],
    ...over,
  } as never;
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  raw = new PrismaClient({ datasourceUrl: DATABASE_URL });
  try {
    await raw.$connect();
    await raw.$queryRaw`SELECT 1`;
    dbAvailable = true;
    // Guard OUTERMOST — дзеркалить prisma.service. Writer біжить БЕЗ runWithTenant.
    guarded = withTenantGuard(raw) as PrismaClient;
    service = new DeadLetterService(guarded as unknown as PrismaService);
  } catch {
    dbAvailable = false;
    handleDbUnavailable('підключення або seed недоступні');
  }
}, 30_000);

afterAll(async () => {
  if (raw && dbAvailable) {
    await raw.deadLetterJob
      .deleteMany({ where: { bullJobId: BULL_JOB_ID } })
      .catch(() => undefined);
    await raw.$disconnect().catch(() => undefined);
  }
});

describe('DeadLetterService.capture — integration (жива БД, tenant-exempt)', () => {
  it('пише DeadLetterJob БЕЗ ambient tenant-контексту (TENANT_EXEMPT + runUnscoped)', async () => {
    if (!dbAvailable) return; // SKIP без БД
    await service.capture(fakeJob(), new Error('integration boom'), 'test-queue');
    const rows = await raw.deadLetterJob.findMany({ where: { bullJobId: BULL_JOB_ID } });
    expect(rows).toHaveLength(1);
    expect(rows[0].queueName).toBe('test-queue');
    expect(rows[0].orgId).toBeNull(); // org-agnostic job (data без orgId)
    expect(rows[0].attemptsMade).toBe(10);
    expect(rows[0].resolved).toBe(false);
  });

  it('orgId з job.data.orgId зберігається (org-scoped job)', async () => {
    if (!dbAvailable) return;
    const org = await raw.organisation.findFirst({ select: { id: true } });
    if (!org) return;
    const jobId = `${BULL_JOB_ID}-org`;
    await service.capture(fakeJob({ id: jobId, data: { orgId: org.id } }), new Error('x'), 'sms');
    const row = await raw.deadLetterJob.findFirst({ where: { bullJobId: jobId } });
    expect(row?.orgId).toBe(org.id);
    await raw.deadLetterJob.deleteMany({ where: { bullJobId: jobId } }).catch(() => undefined);
  });
});
