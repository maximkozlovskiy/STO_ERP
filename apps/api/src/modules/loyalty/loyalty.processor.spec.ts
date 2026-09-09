import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { LoyaltyProcessor } from './loyalty.processor';
import type { LoyaltyService } from './loyalty.service';

// T24: тонкий wrapper над loyaltyService.earn — фіксуємо, що job.data прокидається у earn один-в-один
// (регресія-guard: рефактор, що переплутав би порядок аргументів → нарахування балів не тому/на не-ту суму).
describe('LoyaltyProcessor', () => {
  const earn = vi.fn().mockResolvedValue(undefined);
  const loyaltyService = { earn } as unknown as LoyaltyService;
  let processor: LoyaltyProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new LoyaltyProcessor(loyaltyService);
  });

  const job = (data: Record<string, unknown>) => ({ data }) as unknown as Job;

  it('прокидає (orgId, counterpartyId, paymentAmount, documentId) у earn', async () => {
    await processor.process(
      job({ orgId: 'o1', counterpartyId: 'c1', paymentAmount: 500, documentId: 'pay-1' }),
    );
    expect(earn).toHaveBeenCalledTimes(1);
    expect(earn).toHaveBeenCalledWith('o1', 'c1', 500, 'pay-1');
  });

  it('documentId опційний → undefined прокидається', async () => {
    await processor.process(job({ orgId: 'o1', counterpartyId: 'c1', paymentAmount: 100 }));
    expect(earn).toHaveBeenCalledWith('o1', 'c1', 100, undefined);
  });

  it('помилка earn прокидається (BullMQ retry)', async () => {
    earn.mockRejectedValueOnce(new Error('DB down'));
    await expect(
      processor.process(job({ orgId: 'o1', counterpartyId: 'c1', paymentAmount: 100 })),
    ).rejects.toThrow('DB down');
  });
});
