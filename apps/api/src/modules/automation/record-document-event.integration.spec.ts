import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createPgAdapter } from '../../prisma/pg-adapter';
import { withTenantGuard } from '../../prisma/tenant-guard.extension';
import { runWithTenant } from '../../common/tenant/tenant-context';
import { handleDbUnavailable, testDatabaseUrl } from '../../common/testing/require-db';
import { recordDocumentEvent } from './record-document-event';

/**
 * BR-AUT-060 на ЖИВІЙ БД: подія outbox пишеться в транзакції документа — відкат транзакції не
 * лишає події, коміт лишає рівно одну. Юніт-спеки перевіряють, що сервіси передають `tx`; тут —
 * що сама таблиця й клієнт (через tenant-guard, як у prisma.service) поводяться як обіцяно.
 *
 * Організація — випадковий uuid (у `domain_events` немає FK на організацію); рядки прибираються
 * в `afterAll` за цим orgId. Без БД — SKIP (у CI з REQUIRE_DB=1 — падіння).
 */
const ORG = randomUUID();
const DOC = randomUUID();

let raw: PrismaClient;
let guarded: PrismaClient;
let dbAvailable = false;

beforeAll(async () => {
  raw = new PrismaClient({ adapter: createPgAdapter(testDatabaseUrl()) });
  try {
    await raw.$connect();
    await raw.$queryRaw`SELECT 1 FROM domain_events LIMIT 1`;
    guarded = withTenantGuard(raw) as PrismaClient;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    handleDbUnavailable('підключення або таблиця domain_events недоступні');
  }
}, 30_000);

afterAll(async () => {
  if (raw && dbAvailable) {
    await raw.domainEvent.deleteMany({ where: { orgId: ORG } }).catch(() => undefined);
  }
  await raw?.$disconnect().catch(() => undefined);
});

const eventsOf = () =>
  raw.domainEvent.findMany({
    where: { orgId: ORG, documentId: DOC },
    orderBy: { occurredAt: 'asc' },
  });

describe('recordDocumentEvent — integration (жива БД)', () => {
  // guards: BR-AUT-060
  it('відкат транзакції документа → події немає', async () => {
    if (!dbAvailable) return;
    await expect(
      runWithTenant({ orgId: ORG }, () =>
        guarded.$transaction(async tx => {
          await recordDocumentEvent(tx, {
            orgId: ORG,
            documentType: 'WORK_ORDER',
            documentId: DOC,
            kind: 'STATUS_CHANGED',
            fromStatus: 'APPROVED',
            toStatus: 'IN_PROGRESS',
          });
          throw new Error('зміна документа не вдалась');
        }),
      ),
    ).rejects.toThrow('зміна документа не вдалась');

    expect(await eventsOf()).toHaveLength(0);
  });

  // guards: BR-AUT-060
  it('коміт → рівно одна подія з полями; той самий статус — без події', async () => {
    if (!dbAvailable) return;
    await runWithTenant({ orgId: ORG }, () =>
      guarded.$transaction(async tx => {
        await recordDocumentEvent(tx, {
          orgId: ORG,
          documentType: 'WORK_ORDER',
          documentId: DOC,
          kind: 'STATUS_CHANGED',
          fromStatus: 'APPROVED',
          toStatus: 'IN_PROGRESS',
          actorId: null,
        });
        await recordDocumentEvent(tx, {
          orgId: ORG,
          documentType: 'WORK_ORDER',
          documentId: DOC,
          kind: 'STATUS_CHANGED',
          fromStatus: 'IN_PROGRESS',
          toStatus: 'IN_PROGRESS',
        });
      }),
    );

    const rows = await eventsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      documentType: 'WORK_ORDER',
      kind: 'STATUS_CHANGED',
      fromStatus: 'APPROVED',
      toStatus: 'IN_PROGRESS',
      actorId: null,
      processedAt: null,
      attempts: 0,
    });
  });
});
