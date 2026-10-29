import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '@prisma/client';
import {
  AUTOMATION_EVENTS_BATCH,
  AUTOMATION_RETRY_MAX_MS,
  AutomationEventsProcessor,
  retryDelayMs,
} from './automation-events.processor';
import type { DomainEventHandler } from './domain-event-handler';
import { memoryTable, type MemRow } from '../cash/cash.spec-fixture';
import { getTenantOrgId } from '../../common/tenant/tenant-context';
import type { PrismaService } from '../../prisma/prisma.service';

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const NOW = new Date('2026-10-29T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let seq = 0;
function event(over: MemRow = {}): MemRow {
  seq += 1;
  return {
    id: `evt-${String(seq).padStart(4, '0')}`,
    orgId: ORG_A,
    documentType: 'WORK_ORDER',
    documentId: `doc-${seq}`,
    kind: 'STATUS_CHANGED',
    fromStatus: 'APPROVED',
    toStatus: 'IN_PROGRESS',
    actorId: null,
    occurredAt: ago(60_000 - seq),
    processedAt: null,
    attempts: 0,
    lastError: null,
    deletedAt: null,
    updatedAt: ago(60_000),
    ...over,
  };
}

/** Таблиця в пам'яті виконує `where` / `orderBy` / `take` по-справжньому; запис — `applyData`. */
function harness(rows: MemRow[], handlers: DomainEventHandler[] = []) {
  const domainEvent = memoryTable(rows);
  // `attempts: { increment: 1 }` таблиця в пам'яті не знає — інкремент, як у Prisma.
  const update = domainEvent.updateMany.getMockImplementation()!;
  domainEvent.updateMany.mockImplementation(args => {
    const data = args.data as Record<string, unknown>;
    const inc = (data.attempts as { increment?: number } | undefined)?.increment;
    if (inc === undefined) return update(args);
    const hits = domainEvent.rows.filter(r =>
      Object.entries(args.where as Record<string, unknown>).every(([k, v]) => r[k] === v),
    );
    for (const r of hits) {
      Object.assign(r, { ...data, attempts: Number(r.attempts) + inc, updatedAt: NOW });
    }
    return Promise.resolve({ count: hits.length });
  });
  const prisma = { domainEvent } as unknown as PrismaService;
  const processor = new AutomationEventsProcessor(prisma, handlers);
  const row = (id: string) => domainEvent.rows.find(r => r.id === id)!;
  return { processor, domainEvent, row };
}

describe('AutomationEventsProcessor — обробка outbox (BR-AUT-061)', () => {
  // guards: BR-AUT-061
  it('необроблені події → processedAt; оброблені й видалені не чіпаються', async () => {
    const fresh = event();
    const done = event({ processedAt: ago(1000) });
    const deleted = event({ deletedAt: ago(1000) });
    const h = harness([fresh, done, deleted]);

    const res = await h.processor.processBatch(NOW);

    expect(res).toEqual({ processed: 1, failed: 0 });
    expect(h.row(fresh.id as string).processedAt).toBeInstanceOf(Date);
    expect(h.row(done.id as string).processedAt).toEqual(ago(1000));
    expect(h.row(deleted.id as string).processedAt).toBeNull();
  });

  // guards: BR-AUT-061
  it('порядок — за occurredAt; обробник отримує подію в tenant-scope її організації', async () => {
    const later = event({ orgId: ORG_B, occurredAt: ago(1000) });
    const earlier = event({ orgId: ORG_A, occurredAt: ago(5000) });
    const seen: Array<[string, string | undefined]> = [];
    const handler: DomainEventHandler = {
      name: 'spy',
      handle: (e: DomainEvent) => {
        seen.push([e.id, getTenantOrgId()]);
        return Promise.resolve();
      },
    };
    const h = harness([later, earlier], [handler]);

    await h.processor.processBatch(NOW);

    expect(seen).toEqual([
      [earlier.id, ORG_A],
      [later.id, ORG_B],
    ]);
  });

  // guards: BR-AUT-061
  it('збій обробника → attempts+1, lastError, processedAt лишається null; інші події обробляються', async () => {
    const bad = event({ documentId: 'bad' });
    const good = event({ documentId: 'good' });
    const handler: DomainEventHandler = {
      name: 'flaky',
      handle: (e: DomainEvent) =>
        e.documentId === 'bad' ? Promise.reject(new Error('двигун впав')) : Promise.resolve(),
    };
    const h = harness([bad, good], [handler]);

    const res = await h.processor.processBatch(NOW);

    expect(res).toEqual({ processed: 1, failed: 1 });
    expect(h.row(bad.id as string)).toMatchObject({
      processedAt: null,
      attempts: 1,
      lastError: 'двигун впав',
    });
    expect(h.row(good.id as string).processedAt).toBeInstanceOf(Date);
  });

  // guards: BR-AUT-061
  it('повтор — після експоненційної паузи від останньої спроби (updatedAt)', async () => {
    // attempts=2 → пауза 20 с: оновлена 15 с тому — ще рано, 25 с тому — пора.
    const early = event({ attempts: 2, updatedAt: ago(15_000) });
    const due = event({ attempts: 2, updatedAt: ago(25_000) });
    const h = harness([early, due]);

    await h.processor.processBatch(NOW);

    expect(h.row(early.id as string).processedAt).toBeNull();
    expect(h.row(due.id as string).processedAt).toBeInstanceOf(Date);
  });

  it('retryDelayMs: 0 до першого збою, далі подвоюється від 10 с, стеля — година', () => {
    expect([0, 1, 2, 3].map(retryDelayMs)).toEqual([0, 10_000, 20_000, 40_000]);
    expect(retryDelayMs(50)).toBe(AUTOMATION_RETRY_MAX_MS);
  });

  // guards: BR-AUT-061
  it('пачка подій, що падають, не відсуває свіжі: нові вибираються окремо', async () => {
    const failing = Array.from({ length: AUTOMATION_EVENTS_BATCH }, () =>
      event({ attempts: 3, updatedAt: ago(1000), occurredAt: ago(120_000) }),
    );
    const fresh = event({ occurredAt: ago(500) });
    const h = harness([...failing, fresh]);

    await h.processor.processBatch(NOW);

    expect(h.row(fresh.id as string).processedAt).toBeInstanceOf(Date);
  });

  // guards: BR-AUT-061
  it('позначка обробки — CAS за id + orgId + processedAt:null (не перезаписує чужу обробку)', async () => {
    const e = event();
    const h = harness([e]);
    await h.processor.processBatch(NOW);
    expect(h.domainEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: e.id, orgId: ORG_A, processedAt: null } }),
    );
  });

  it('process(job) — той самий прохід', async () => {
    const e = event();
    const h = harness([e]);
    await h.processor.process({} as never);
    expect(h.row(e.id as string).processedAt).toBeInstanceOf(Date);
  });
});
