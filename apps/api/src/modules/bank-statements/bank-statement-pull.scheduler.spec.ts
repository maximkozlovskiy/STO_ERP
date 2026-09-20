import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BankStatementPullScheduler } from './bank-statement-pull.scheduler';

/**
 * BankStatementPullScheduler — repeatable/immediate постановка pull-job. Доводимо: reschedule
 * (видалення старого repeatable + re-add з новим інтервалом, clamp [15,1440]); enqueueImmediate
 * (окремий jobId проти дедупу з cron).
 */
describe('BankStatementPullScheduler', () => {
  let queue: {
    add: ReturnType<typeof vi.fn>;
    getRepeatableJobs: ReturnType<typeof vi.fn>;
    removeRepeatableByKey: ReturnType<typeof vi.fn>;
  };
  let prisma: { organisationSettings: { findMany: ReturnType<typeof vi.fn> } };
  let scheduler: BankStatementPullScheduler;
  const ORG = 'org-1';

  beforeEach(() => {
    queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getRepeatableJobs: vi.fn().mockResolvedValue([]),
      removeRepeatableByKey: vi.fn().mockResolvedValue(undefined),
    };
    prisma = { organisationSettings: { findMany: vi.fn().mockResolvedValue([]) } };
    scheduler = new BankStatementPullScheduler(queue as never, prisma as never);
  });

  it('rescheduleForOrg: видаляє старий repeatable + re-add з новим інтервалом', async () => {
    queue.getRepeatableJobs.mockResolvedValue([
      { key: 'bank-pull-other:::', id: null },
      { key: `x:bank-pull-${ORG}:every`, id: null },
    ]);
    await scheduler.rescheduleForOrg(ORG, 120);
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith(`x:bank-pull-${ORG}:every`);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe('pull');
    expect(data).toEqual({ orgId: ORG });
    expect(opts.repeat.every).toBe(120 * 60_000);
    expect(opts.jobId).toBe(`bank-pull-${ORG}`);
    expect(opts.repeat.tz).toBe('Europe/Kyiv');
  });

  it('reschedule clamp: <15 → 15, >1440 → 1440', async () => {
    await scheduler.rescheduleForOrg(ORG, 5);
    expect(queue.add.mock.calls[0][2].repeat.every).toBe(15 * 60_000);
    queue.add.mockClear();
    await scheduler.rescheduleForOrg(ORG, 9999);
    expect(queue.add.mock.calls[0][2].repeat.every).toBe(1440 * 60_000);
  });

  it('enqueueImmediate: окремий jobId bank-pull-now-<org>', async () => {
    const res = await scheduler.enqueueImmediate(ORG);
    expect(res).toEqual({ queued: true });
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe('pull');
    expect(data).toEqual({ orgId: ORG });
    expect(opts.jobId).toBe(`bank-pull-now-${ORG}`);
    expect(opts.repeat).toBeUndefined();
  });

  it('onModuleinit без reschedule не викликається окремо: reschedule видаляє лише свій org-key', async () => {
    queue.getRepeatableJobs.mockResolvedValue([{ key: `bank-pull-org-2:every`, id: null }]);
    await scheduler.rescheduleForOrg(ORG, 60);
    // Ключ іншої орг не чіпаємо.
    expect(queue.removeRepeatableByKey).not.toHaveBeenCalled();
  });
});
