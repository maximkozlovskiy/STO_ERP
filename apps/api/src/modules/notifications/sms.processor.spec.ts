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

  it('chainIndex поза межами (>= chain.length) → no-op, без send/log/throw', async () => {
    await expect(processor.process(makeJob(2))).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(logCreate).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('порожній chain → no-op, без крашу', async () => {
    await expect(processor.process(makeJob(0, []))).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('MIXED: середній канал reject → наступний job; той accept → рівно 1 SENT + 1 REJECTED, без подвійної відправки', async () => {
    // Job A (chainIndex=0, VIBER): reject → REJECTED + новий job chainIndex=1, без throw
    send.mockResolvedValueOnce({ accepted: false, error: 'VIBER_DOWN' });
    await processor.process(makeJob(0));
    expect(queueAdd.mock.calls[0][1].chainIndex).toBe(1);
    const rejectedCalls = logCreate.mock.calls.filter(c => c[0].data.status === 'REJECTED');
    expect(rejectedCalls).toHaveLength(1);
    expect(rejectedCalls[0][0].data.channel).toBe(NotificationChannel.VIBER);

    // Job B (chainIndex=1, SMS): accept → SENT, СТОП
    vi.clearAllMocks();
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValue({ send });
    send.mockResolvedValueOnce({ accepted: true, providerMessageId: 's-1' });
    await processor.process(makeJob(1));
    expect(send).toHaveBeenCalledTimes(1); // жодної повторної відправки VIBER
    const sentCalls = logCreate.mock.calls.filter(c => c[0].data.status === 'SENT');
    expect(sentCalls).toHaveLength(1);
    expect(sentCalls[0][0].data.channel).toBe(NotificationChannel.SMS);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('RETRY: reject на ОСТАННЬОМУ каналі → throw; chainIndex у job.data незмінний (BullMQ повторить той самий канал)', async () => {
    const job = makeJob(1);
    send.mockResolvedValueOnce({ accepted: false, error: 'SMS_TIMEOUT' });
    await expect(processor.process(job)).rejects.toThrow('SMS_TIMEOUT');
    // chainIndex НЕ змінюється — retry повторить chain[1], не рестартує з 0 і не скіпне
    expect(job.data.chainIndex).toBe(1);
    expect(queueAdd).not.toHaveBeenCalled(); // без нового fallback-job
  });

  it('PII: application-логи маскують телефон до останніх 4 цифр (повний номер лише у NotificationLog.phone)', async () => {
    const logSpy = vi.spyOn(processor['logger'], 'log');
    send.mockResolvedValueOnce({ accepted: true, providerMessageId: 'v-1' });
    await processor.process(makeJob(0));
    const line = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(line).toContain('****2233');
    expect(line).not.toContain('380671112233'); // повний номер не витікає у app-логи
    // але у NotificationLog.phone зберігається повний номер (delivery-запис)
    expect(logCreate.mock.calls[0][0].data.phone).toBe('380671112233');
    logSpy.mockRestore();
  });
});
