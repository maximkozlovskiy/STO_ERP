import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { InvoiceOverdueProcessor } from './invoice-overdue.processor';

/**
 * InvoiceOverdueProcessor — щоденне позначення прострочених рахунків OVERDUE.
 * Доводимо: updateMany лише для SENT/PARTIALLY_PAID з dueDate<сьогодні; tenant orgId;
 * deletedAt:null; PAID/CANCELLED/OVERDUE не чіпаються; null-dueDate виключено.
 */
describe('InvoiceOverdueProcessor', () => {
  let processor: InvoiceOverdueProcessor;
  let prisma: { invoice: { updateMany: ReturnType<typeof vi.fn> } };

  const ORG = 'org-1';
  const makeJob = (orgId: string): Job<{ orgId: string }> =>
    ({ data: { orgId } }) as Job<{ orgId: string }>;

  beforeEach(() => {
    prisma = { invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } };
    processor = new InvoiceOverdueProcessor(prisma as never);
  });

  it('updateMany: SENT/PARTIALLY_PAID + dueDate<сьогодні + orgId + deletedAt:null → OVERDUE', async () => {
    prisma.invoice.updateMany.mockResolvedValue({ count: 3 });
    await processor.process(makeJob(ORG));
    expect(prisma.invoice.updateMany).toHaveBeenCalledTimes(1);
    const arg = prisma.invoice.updateMany.mock.calls[0][0];
    expect(arg.where.orgId).toBe(ORG);
    expect(arg.where.deletedAt).toBeNull();
    expect(arg.where.status).toEqual({ in: ['SENT', 'PARTIALLY_PAID'] });
    // dueDate: не null І < сьогодні (Date).
    expect(arg.where.dueDate.not).toBeNull();
    expect(arg.where.dueDate.lt).toBeInstanceOf(Date);
    expect(arg.data).toEqual({ status: 'OVERDUE' });
  });

  it('НЕ чіпає PAID/CANCELLED/OVERDUE (status-фільтр лише SENT/PARTIALLY_PAID)', async () => {
    await processor.process(makeJob(ORG));
    const statusIn = prisma.invoice.updateMany.mock.calls[0][0].where.status.in;
    expect(statusIn).not.toContain('PAID');
    expect(statusIn).not.toContain('CANCELLED');
    expect(statusIn).not.toContain('OVERDUE'); // ідемпотентність: вже-OVERDUE не переоброблюється
  });

  it('null-dueDate виключено (рахунок без терміну не прострочується)', async () => {
    await processor.process(makeJob(ORG));
    expect(prisma.invoice.updateMany.mock.calls[0][0].where.dueDate.not).toBeNull();
  });

  it('tenant: інша org → інший orgId у where', async () => {
    await processor.process(makeJob('org-9'));
    expect(prisma.invoice.updateMany.mock.calls[0][0].where.orgId).toBe('org-9');
  });
});
