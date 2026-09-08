import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { IntegrationLogPurgeProcessor, PurgeJob } from './integration-log-purge.processor';
import { kyivToday, addDaysKyiv } from '../../common/utils/kyiv-date';

/**
 * Purge видаляє IntegrationLog старші за retention. Критично: ORGID-SCOPED (інші org не зачеплені),
 * retention clamp [1,365] + fallback 30, hard delete (append-only таблиця).
 */
describe('IntegrationLogPurgeProcessor', () => {
  let processor: IntegrationLogPurgeProcessor;
  let findUnique: ReturnType<typeof vi.fn>;
  let deleteMany: ReturnType<typeof vi.fn>;

  const makeJob = (orgId = 'org-1') => ({ data: { orgId } }) as Job<PurgeJob>;

  beforeEach(() => {
    findUnique = vi.fn().mockResolvedValue({ integrationLogRetentionDays: 30 });
    deleteMany = vi.fn().mockResolvedValue({ count: 5 });
    const prisma = {
      organisationSettings: { findUnique },
      integrationLog: { deleteMany },
    } as never;
    processor = new IntegrationLogPurgeProcessor(prisma);
  });

  it('deleteMany ЗАВЖДИ orgId-scoped + createdAt < cutoff', async () => {
    await processor.process(makeJob('org-1'));
    expect(deleteMany).toHaveBeenCalledTimes(1);
    const where = deleteMany.mock.calls[0][0].where;
    expect(where.orgId).toBe('org-1'); // ніколи глобально
    expect(where.createdAt.lt).toBeInstanceOf(Date);
  });

  it('cutoff = today − retentionDays (менший retention → пізніший cutoff)', async () => {
    findUnique.mockResolvedValue({ integrationLogRetentionDays: 7 });
    await processor.process(makeJob());
    const cutoff7 = deleteMany.mock.calls[0][0].where.createdAt.lt as Date;

    deleteMany.mockClear();
    findUnique.mockResolvedValue({ integrationLogRetentionDays: 90 });
    await processor.process(makeJob());
    const cutoff90 = deleteMany.mock.calls[0][0].where.createdAt.lt as Date;

    // 90 днів → давніший cutoff, ніж 7 днів
    expect(cutoff90.getTime()).toBeLessThan(cutoff7.getTime());
  });

  it('немає settings → fallback 30 днів (не падає)', async () => {
    findUnique.mockResolvedValue(null);
    await expect(processor.process(makeJob())).resolves.toBeUndefined();
    expect(deleteMany).toHaveBeenCalled();
  });

  it('retention clamp: 0 → 1 день (не видаляє все)', async () => {
    findUnique.mockResolvedValue({ integrationLogRetentionDays: 0 });
    await processor.process(makeJob());
    // clamp до MIN=1 → cutoff = Kyiv-північ (today−1), не today (не зносить сьогоднішні).
    // Порівнюємо з тією ж Kyiv-семантикою, що й код (НЕ wall-clock delta — біля добової межі
    // локальний Date.now() vs Kyiv-midnight давав хибний ~21h і тест flaky, а не через код).
    const cutoff = deleteMany.mock.calls[0][0].where.createdAt.lt as Date;
    expect(cutoff.getTime()).toBe(addDaysKyiv(kyivToday(), -1).getTime());
  });

  it('retention clamp: 9999 → 365 днів (верхня межа)', async () => {
    findUnique.mockResolvedValue({ integrationLogRetentionDays: 9999 });
    await processor.process(makeJob());
    const cutoff = deleteMany.mock.calls[0][0].where.createdAt.lt as Date;
    // clamp до MAX=365 → cutoff = Kyiv-північ (today−365). Точне порівняння з Kyiv-семантикою коду
    // (не wall-clock delta, який flaky біля добової межі та на DST-переходах).
    expect(cutoff.getTime()).toBe(addDaysKyiv(kyivToday(), -365).getTime());
  });
});
