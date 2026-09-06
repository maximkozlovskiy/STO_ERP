import { vi, describe, it, expect, beforeEach } from 'vitest';
import { NotificationChannel } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { SmsProcessor } from './sms.processor';
import { NotificationProviderRegistry } from './providers/provider-registry';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Fallback-engine: chain[chainIndex] accepted → STOP; reject → наступний канал новим job;
 * останній канал reject → throw (BullMQ retry). NotificationLog пишеться на кожну спробу.
 */
describe('SmsProcessor (fallback engine)', () => {
  const send = vi.fn();
  const registry = { get: vi.fn() } as unknown as NotificationProviderRegistry;
  const logCreate = vi.fn().mockResolvedValue({});
  const prisma = { notificationLog: { create: logCreate } } as unknown as PrismaService;
  const queueAdd = vi.fn().mockResolvedValue({});
  const queue = { add: queueAdd } as unknown as Queue;

  let processor: SmsProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValue({ send });
    processor = new SmsProcessor(registry, prisma, queue);
  });

  const step = (channel: NotificationChannel) => ({
    channel,
    provider: 'turbosms',
    apiKey: 'tok',
    senderName: 'STO',
    message: `msg-${channel}`,
  });

  const makeJob = (
    chainIndex: number,
    chain = [step(NotificationChannel.VIBER), step(NotificationChannel.SMS)],
  ) =>
    ({
      data: {
        orgId: 'org-1',
        branchId: 'br-1',
        event: 'WO_COMPLETED',
        phone: '380671112233',
        chain,
        chainIndex,
      },
      attemptsMade: 0,
    }) as unknown as Job;

  it('канал[0] accepted → STOP, лог SENT, наступний job НЕ ставиться', async () => {
    send.mockResolvedValueOnce({ accepted: true, providerMessageId: 'v-1' });
    await processor.process(makeJob(0));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].channel).toBe(NotificationChannel.VIBER);
    expect(queueAdd).not.toHaveBeenCalled();
    expect(logCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SENT', channel: NotificationChannel.VIBER }),
      }),
    );
  });

  it('канал[0] reject (є наступний) → лог REJECTED + новий job на chainIndex=1, НЕ throw', async () => {
    send.mockResolvedValueOnce({ accepted: false, error: 'VIBER_UNREACHABLE' });
    await expect(processor.process(makeJob(0))).resolves.toBeUndefined();
    expect(logCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED' }) }),
    );
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd.mock.calls[0][1].chainIndex).toBe(1);
  });

  it('останній канал reject → throw (BullMQ retry), новий job НЕ ставиться', async () => {
    send.mockResolvedValueOnce({ accepted: false, error: 'SMS_REJECTED' });
    await expect(processor.process(makeJob(1))).rejects.toThrow('SMS_REJECTED');
    expect(queueAdd).not.toHaveBeenCalled();
    expect(logCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'REJECTED', channel: NotificationChannel.SMS }),
      }),
    );
  });

  it('невідомий провайдер → лог FAILED + fallback на наступний канал', async () => {
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    await expect(processor.process(makeJob(0))).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(logCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd.mock.calls[0][1].chainIndex).toBe(1);
  });

  it('невідомий провайдер на ОСТАННЬОМУ каналі → лог FAILED, НЕ throw, без нового job', async () => {
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    await expect(processor.process(makeJob(1))).resolves.toBeUndefined();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('помилка запису NotificationLog не зриває відправку', async () => {
    logCreate.mockRejectedValueOnce(new Error('DB down'));
    send.mockResolvedValueOnce({ accepted: true, providerMessageId: 'v-1' });
    await expect(processor.process(makeJob(0))).resolves.toBeUndefined();
  });
});
