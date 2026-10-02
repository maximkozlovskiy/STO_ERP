import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { PurgeJob } from './dead-letter-purge.processor';
import { DeadLetterPurgeProcessor } from './dead-letter-purge.processor';
import { kyivToday, addDaysKyiv } from '../../common/utils/kyiv-date';

// runUnscoped мокаємо pass-through: тест перевіряє where-контракт, не ALS-обгортку.
vi.mock('../../common/tenant/tenant-context', async importOriginal => {
  const actual = await importOriginal<typeof import('../../common/tenant/tenant-context')>();
  return {
    ...actual,
    runUnscoped: <T>(fn: () => T): T => fn(),
  };
});

/**
 * Purge видаляє RESOLVED DeadLetterJob старші за retention. Критично:
 *  - resolved:true ЗАВЖДИ у where (нерозв'язані НІКОЛИ не видаляються);
 *  - per-org: orgId-scoped, retention clamp [7,730] + fallback 180;
 *  - null-org: глобальний sweep {orgId:null} через runUnscoped.
 */
describe('DeadLetterPurgeProcessor', () => {
  let processor: DeadLetterPurgeProcessor;
  let findUnique: ReturnType<typeof vi.fn>;
  let deleteMany: ReturnType<typeof vi.fn>;

  const makeJob = (orgId: string | null = 'org-1') => ({ data: { orgId } }) as Job<PurgeJob>;

  beforeEach(() => {
    findUnique = vi.fn().mockResolvedValue({ deadLetterRetentionDays: 180 });
    deleteMany = vi.fn().mockResolvedValue({ count: 5 });
    const prisma = {
      organisationSettings: { findUnique },
      deadLetterJob: { deleteMany },
    } as never;
    processor = new DeadLetterPurgeProcessor(prisma, { capture: vi.fn() } as never);
  });

  it('per-org: deleteMany orgId-scoped + resolved:true + createdAt < cutoff', async () => {
    await processor.process(makeJob('org-1'));
    expect(deleteMany).toHaveBeenCalledTimes(1);
    const where = deleteMany.mock.calls[0][0].where;
    expect(where.orgId).toBe('org-1'); // ніколи глобально у per-org режимі
    expect(where.resolved).toBe(true);
    expect(where.createdAt.lt).toBeInstanceOf(Date);
  });

  it('resolved=false НІКОЛИ не потрапляє у where (unresolved провали постійні)', async () => {
    await processor.process(makeJob('org-1'));
    const where = deleteMany.mock.calls[0][0].where;
    // Захист: where.resolved мусить бути строго true — інакше видалимо нерозв'язані.
    expect(where.resolved).toBe(true);
    expect(where.resolved).not.toBe(false);
  });

  it('clamp: settings=5 → MIN=7 днів (не менше 7)', async () => {
    findUnique.mockResolvedValue({ deadLetterRetentionDays: 5 });
    await processor.process(makeJob());
    const cutoff = deleteMany.mock.calls[0][0].where.createdAt.lt as Date;
    expect(cutoff.getTime()).toBe(addDaysKyiv(kyivToday(), -7).getTime());
  });

  it('clamp: settings=9999 → MAX=730 днів (верхня межа)', async () => {
    findUnique.mockResolvedValue({ deadLetterRetentionDays: 9999 });
    await processor.process(makeJob());
    const cutoff = deleteMany.mock.calls[0][0].where.createdAt.lt as Date;
    expect(cutoff.getTime()).toBe(addDaysKyiv(kyivToday(), -730).getTime());
  });

  it('немає settings → fallback 180 днів (не падає)', async () => {
    findUnique.mockResolvedValue(null);
    await processor.process(makeJob());
    const cutoff = deleteMany.mock.calls[0][0].where.createdAt.lt as Date;
    expect(cutoff.getTime()).toBe(addDaysKyiv(kyivToday(), -180).getTime());
  });

  it('null-org: глобальний sweep {orgId:null, resolved:true} через runUnscoped (DEFAULT retention)', async () => {
    await processor.process(makeJob(null));
    expect(deleteMany).toHaveBeenCalledTimes(1);
    const where = deleteMany.mock.calls[0][0].where;
    expect(where.orgId).toBeNull();
    expect(where.resolved).toBe(true);
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    // null-org не читає per-org settings → DEFAULT 180.
    expect(findUnique).not.toHaveBeenCalled();
    const cutoff = where.createdAt.lt as Date;
    expect(cutoff.getTime()).toBe(addDaysKyiv(kyivToday(), -180).getTime());
  });
});
