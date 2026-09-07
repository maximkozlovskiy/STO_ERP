import { vi, describe, it, expect, beforeEach } from 'vitest';
import { DeliveryTrackingService } from './delivery-tracking.service';

/**
 * DeliveryTrackingService — pollDelayMs clamp [5,1440] хв + enqueueInitial (jobId single-flight,
 * offline-safe). Bug #697 (test-gap): весь сервіс жив без прямих тестів; clamp — load-bearing
 * проти нескінченно-частого/мертвого polling.
 * MUTATION-VERIFY: прибрати Math.min(...,MAX) → 9999-тест падає; прибрати Math.max(...,MIN) → 0/2-тести падають.
 */
describe('DeliveryTrackingService', () => {
  const ORG = 'org-1';
  const PO = 'po-1';
  let settings: { getOrganisationSettings: ReturnType<typeof vi.fn> };
  let pollQueue: { add: ReturnType<typeof vi.fn> };
  let service: DeliveryTrackingService;

  const withInterval = (v: unknown) =>
    settings.getOrganisationSettings.mockResolvedValue({ deliveryPollIntervalMinutes: v });

  beforeEach(() => {
    settings = { getOrganisationSettings: vi.fn().mockResolvedValue({}) };
    pollQueue = { add: vi.fn().mockResolvedValue(undefined) };
    service = new DeliveryTrackingService(settings as never, pollQueue as never);
  });

  describe('pollDelayMs — clamp [5,1440] хв', () => {
    it('валідне значення 30 → 30 хв (у мс)', async () => {
      withInterval(30);
      expect(await service.pollDelayMs(ORG)).toBe(30 * 60_000);
    });

    it('0 → clamp до MIN 5 хв', async () => {
      withInterval(0);
      expect(await service.pollDelayMs(ORG)).toBe(5 * 60_000);
    });

    it('негативне (−10) → clamp до MIN 5 хв', async () => {
      withInterval(-10);
      expect(await service.pollDelayMs(ORG)).toBe(5 * 60_000);
    });

    it('2 (нижче MIN) → clamp до 5 хв', async () => {
      withInterval(2);
      expect(await service.pollDelayMs(ORG)).toBe(5 * 60_000);
    });

    it('9999 (вище MAX) → clamp до 1440 хв', async () => {
      withInterval(9999);
      expect(await service.pollDelayMs(ORG)).toBe(1440 * 60_000);
    });

    it('1440 (рівно MAX) → 1440 хв', async () => {
      withInterval(1440);
      expect(await service.pollDelayMs(ORG)).toBe(1440 * 60_000);
    });

    it('NaN/Infinity (не Number.isFinite) → дефолт 30 хв', async () => {
      withInterval(Number.NaN);
      expect(await service.pollDelayMs(ORG)).toBe(30 * 60_000);
      withInterval(Number.POSITIVE_INFINITY);
      expect(await service.pollDelayMs(ORG)).toBe(30 * 60_000);
    });

    it('поле відсутнє у налаштуваннях → дефолт 30 хв', async () => {
      settings.getOrganisationSettings.mockResolvedValue({});
      expect(await service.pollDelayMs(ORG)).toBe(30 * 60_000);
    });

    it('налаштування недоступні (throw) → дефолт 30 хв (не блокуємо трекінг)', async () => {
      settings.getOrganisationSettings.mockRejectedValue(new Error('db down'));
      expect(await service.pollDelayMs(ORG)).toBe(30 * 60_000);
    });
  });

  describe('enqueueInitial', () => {
    it('ставить poll-job з jobId single-flight (np-poll-<poId>) і delay=0 (одразу)', async () => {
      await service.enqueueInitial(ORG, PO);
      expect(pollQueue.add).toHaveBeenCalledTimes(1);
      const [name, data, opts] = pollQueue.add.mock.calls[0];
      expect(name).toBe('poll');
      expect(data).toEqual({ purchaseOrderId: PO, orgId: ORG });
      // payload НЕ несе trackingNumber (job re-read з БД); jobId дедуп single-flight.
      expect(data).not.toHaveProperty('trackingNumber');
      expect(opts.jobId).toBe(`np-poll-${PO}`);
      expect(opts.delay ?? 0).toBe(0);
      expect(opts.removeOnComplete).toBe(true);
    });

    it('offline-safe: черга кидає → enqueueInitial НЕ кидає (PO усе одно збережений)', async () => {
      pollQueue.add.mockRejectedValue(new Error('Redis unavailable'));
      await expect(service.enqueueInitial(ORG, PO)).resolves.toBeUndefined();
    });
  });
});
