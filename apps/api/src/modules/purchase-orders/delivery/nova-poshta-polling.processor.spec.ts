import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { NovaPoshtaPollingProcessor } from './nova-poshta-polling.processor';

/**
 * NovaPoshtaPollingProcessor — self-re-enqueue трекінгу доставки PurchaseOrder.
 * Доводимо: оновлення статусу; зупинка на термінальному/зникненні ЕН/видаленні PO/cap;
 * re-enqueue з delay з налаштувань; конфіг-стан (немає провайдера) → не FAILED; tenant orgId.
 */
const MAX_POLL_ATTEMPTS = 480;

function makeJob(data: {
  purchaseOrderId: string;
  orgId: string;
  pollAttempts?: number;
}): Job<typeof data> {
  return { data } as Job<typeof data>;
}

describe('NovaPoshtaPollingProcessor', () => {
  let processor: NovaPoshtaPollingProcessor;
  let prisma: {
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  };
  let providerConfig: { resolveActive: ReturnType<typeof vi.fn> };
  let providerImpl: { getStatus: ReturnType<typeof vi.fn> };
  let registry: { get: ReturnType<typeof vi.fn> };
  let tracking: { pollDelayMs: ReturnType<typeof vi.fn> };
  let pollQueue: { add: ReturnType<typeof vi.fn> };

  const ORG = 'org-1';
  const PO = 'po-1';

  const poRow = (over: Record<string, unknown> = {}) => ({
    trackingNumber: '204...',
    deliveryStatus: 'PENDING',
    warehouse: { branchId: 'br-1' },
    ...over,
  });

  beforeEach(() => {
    prisma = {
      purchaseOrder: {
        findFirst: vi.fn().mockResolvedValue(poRow()),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    providerConfig = {
      resolveActive: vi.fn().mockResolvedValue({
        provider: 'novaposhta',
        apiUrl: null,
        credentials: { apiKey: 'K' },
        shiftMode: 'MANUAL',
      }),
    };
    providerImpl = {
      getStatus: vi.fn().mockResolvedValue({ status: 'IN_TRANSIT', raw: 'у дорозі' }),
    };
    registry = { get: vi.fn().mockReturnValue(providerImpl) };
    tracking = { pollDelayMs: vi.fn().mockResolvedValue(30 * 60_000) };
    pollQueue = { add: vi.fn().mockResolvedValue(undefined) };
    processor = new NovaPoshtaPollingProcessor(
      prisma as never,
      providerConfig as never,
      registry as never,
      tracking as never,
      pollQueue as never,
    );
  });

  it('PO видалено → стоп (не опитуємо, не re-enqueue)', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue(null);
    await processor.process(makeJob({ purchaseOrderId: PO, orgId: ORG }));
    expect(providerImpl.getStatus).not.toHaveBeenCalled();
    expect(pollQueue.add).not.toHaveBeenCalled();
  });

  it('ЕН прибрано (trackingNumber=null) → стоп', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue(poRow({ trackingNumber: null }));
    await processor.process(makeJob({ purchaseOrderId: PO, orgId: ORG }));
    expect(providerImpl.getStatus).not.toHaveBeenCalled();
    expect(pollQueue.add).not.toHaveBeenCalled();
  });

  it('термінальний статус у БД → стоп (не опитуємо)', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue(poRow({ deliveryStatus: 'DELIVERED' }));
    await processor.process(makeJob({ purchaseOrderId: PO, orgId: ORG }));
    expect(providerImpl.getStatus).not.toHaveBeenCalled();
    expect(pollQueue.add).not.toHaveBeenCalled();
  });

  it('немає активної служби → не FAILED, не re-enqueue (конфіг-стан)', async () => {
    providerConfig.resolveActive.mockResolvedValue(null);
    await processor.process(makeJob({ purchaseOrderId: PO, orgId: ORG }));
    expect(providerImpl.getStatus).not.toHaveBeenCalled();
    expect(prisma.purchaseOrder.updateMany).not.toHaveBeenCalled();
    expect(pollQueue.add).not.toHaveBeenCalled();
  });

  it('статус змінився → update PO (delivery-метадані) + re-enqueue з delay з налаштувань', async () => {
    providerImpl.getStatus.mockResolvedValue({ status: 'ARRIVED', raw: 'на відділенні' });
    await processor.process(makeJob({ purchaseOrderId: PO, orgId: ORG }));
    // update лише delivery-полів (не status закупівлі), scoped orgId+deletedAt (race-safe).
    expect(prisma.purchaseOrder.updateMany).toHaveBeenCalledWith({
      where: { id: PO, orgId: ORG, deletedAt: null },
      data: {
        deliveryStatus: 'ARRIVED',
        deliveryStatusRaw: 'на відділенні',
        deliveryStatusUpdatedAt: expect.any(Date),
      },
    });
    // re-enqueue з delay = pollDelayMs, jobId-дедуп, pollAttempts+1.
    expect(tracking.pollDelayMs).toHaveBeenCalledWith(ORG);
    expect(pollQueue.add).toHaveBeenCalledTimes(1);
    const [, jobData, opts] = pollQueue.add.mock.calls[0];
    expect(jobData).toEqual({ purchaseOrderId: PO, orgId: ORG, pollAttempts: 1 });
    expect(opts.delay).toBe(30 * 60_000);
    expect(opts.jobId).toBe(`np-poll-${PO}`);
  });

  it('статус НЕ змінився → update НЕ викликається, але re-enqueue продовжується', async () => {
    providerImpl.getStatus.mockResolvedValue({ status: 'PENDING', raw: 'очікує' });
    await processor.process(makeJob({ purchaseOrderId: PO, orgId: ORG }));
    expect(prisma.purchaseOrder.updateMany).not.toHaveBeenCalled();
    expect(pollQueue.add).toHaveBeenCalledTimes(1);
  });

  it('термінальний статус з опитування → update + СТОП (не re-enqueue)', async () => {
    providerImpl.getStatus.mockResolvedValue({ status: 'DELIVERED', raw: 'отримано' });
    await processor.process(makeJob({ purchaseOrderId: PO, orgId: ORG }));
    expect(prisma.purchaseOrder.updateMany).toHaveBeenCalled();
    expect(pollQueue.add).not.toHaveBeenCalled();
    // MUTATION-VERIFY: якби TERMINAL не зупиняв → pollQueue.add викликався б.
  });

  it('транзієнтна помилка getStatus → re-enqueue (не зупиняємо трекінг)', async () => {
    providerImpl.getStatus.mockRejectedValue(new Error('НП timeout'));
    await processor.process(makeJob({ purchaseOrderId: PO, orgId: ORG }));
    expect(prisma.purchaseOrder.updateMany).not.toHaveBeenCalled();
    expect(pollQueue.add).toHaveBeenCalledTimes(1);
    expect(pollQueue.add.mock.calls[0][1].pollAttempts).toBe(1);
  });

  it('cap: pollAttempts на межі MAX → НЕ re-enqueue (зупинка зомбі-poll)', async () => {
    providerImpl.getStatus.mockResolvedValue({ status: 'IN_TRANSIT', raw: 'x' });
    await processor.process(
      makeJob({ purchaseOrderId: PO, orgId: ORG, pollAttempts: MAX_POLL_ATTEMPTS }),
    );
    // next = MAX+1 > MAX → стоп.
    expect(pollQueue.add).not.toHaveBeenCalled();
  });

  it('tenant: findFirst несе orgId+deletedAt; resolveActive — branchId складу', async () => {
    await processor.process(makeJob({ purchaseOrderId: PO, orgId: ORG }));
    expect(prisma.purchaseOrder.findFirst.mock.calls[0][0].where).toMatchObject({
      id: PO,
      orgId: ORG,
      deletedAt: null,
    });
    expect(providerConfig.resolveActive).toHaveBeenCalledWith(ORG, 'br-1', 'DELIVERY');
  });

  // Bug #698: zombie-job / jobId single-flight — re-enqueue шле стабільний jobId np-poll-<poId>
  // (same як enqueueInitial) → BullMQ дедуп: старий delayed job не подвоюється новим.
  it('re-enqueue: jobId стабільний (np-poll-<poId>) — single-flight на документ', async () => {
    providerImpl.getStatus.mockResolvedValue({ status: 'IN_TRANSIT', raw: 'x' });
    await processor.process(makeJob({ purchaseOrderId: PO, orgId: ORG }));
    const opts = pollQueue.add.mock.calls[0][2];
    expect(opts.jobId).toBe(`np-poll-${PO}`);
    expect(opts.removeOnComplete).toBe(true);
  });

  // Bug #698: payload НЕ несе trackingNumber → зомбі-job (ЕН змінили між постановкою і виконанням)
  // re-read з БД бачить СВІЖИЙ ЕН у findFirst → опитує актуальний, не подвоює за старим.
  it('zombie-job: job.data НЕ містить ЕН — трекінг керується re-read з БД (не payload)', async () => {
    providerImpl.getStatus.mockResolvedValue({ status: 'IN_TRANSIT', raw: 'x' });
    await processor.process(makeJob({ purchaseOrderId: PO, orgId: ORG }));
    const reEnqueued = pollQueue.add.mock.calls[0][1];
    expect(reEnqueued).toEqual({ purchaseOrderId: PO, orgId: ORG, pollAttempts: 1 });
    expect(reEnqueued).not.toHaveProperty('trackingNumber');
    // getStatus опитаний за ЕН з findFirst (БД), не з payload.
    expect(providerImpl.getStatus.mock.calls[0][1]).toBe('204...');
  });
});
