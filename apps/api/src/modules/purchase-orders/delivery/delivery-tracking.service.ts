import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SettingsService } from '../../settings/settings.service';

// Межі інтервалу опитування (хв) — clamp проти 0/негативних/надто рідкісних значень.
const MIN_POLL_MINUTES = 5;
const MAX_POLL_MINUTES = 1440;
const DEFAULT_POLL_MINUTES = 30;

/**
 * Керує enqueue-ом опитування статусу доставки для PurchaseOrder. Викликається з
 * PurchaseOrdersService при вказанні/зміні номера накладної (trackingNumber). jobId-дедуп
 * (`np-poll-<poId>`) гарантує single-flight на документ. Інтервал — з OrganisationSettings
 * (deliveryPollIntervalMinutes, НЕ hardcoded), clamp [5,1440].
 */
@Injectable()
export class DeliveryTrackingService {
  private readonly logger = new Logger(DeliveryTrackingService.name);

  constructor(
    private readonly settings: SettingsService,
    @InjectQueue('nova-poshta-polling') private readonly pollQueue: Queue,
  ) {}

  /** Інтервал опитування у мс (з OrganisationSettings, clamp [5,1440] хв). */
  async pollDelayMs(orgId: string): Promise<number> {
    let minutes = DEFAULT_POLL_MINUTES;
    try {
      const s = await this.settings.getOrganisationSettings(orgId);
      const raw = (s as { deliveryPollIntervalMinutes?: number }).deliveryPollIntervalMinutes;
      if (typeof raw === 'number' && Number.isFinite(raw)) minutes = raw;
    } catch {
      // Налаштування недоступні → дефолт (не блокуємо трекінг).
    }
    minutes = Math.min(Math.max(minutes, MIN_POLL_MINUTES), MAX_POLL_MINUTES);
    return minutes * 60_000;
  }

  /**
   * Поставити перший poll-job (delay=0 — опитати одразу після вказання ЕН). offline-safe:
   * помилка черги логується, PurchaseOrder усе одно збережений (poll підхопиться при наступному
   * update або ручному refresh).
   */
  async enqueueInitial(orgId: string, purchaseOrderId: string): Promise<void> {
    await this.pollQueue
      .add(
        'poll',
        { purchaseOrderId, orgId },
        { jobId: `np-poll-${purchaseOrderId}`, removeOnComplete: true, removeOnFail: 200 },
      )
      .catch((e: unknown) =>
        this.logger.warn(
          `Черга недоступна — трекінг ${purchaseOrderId} не поставлено: ${
            e instanceof Error ? e.message : e
          }`,
        ),
      );
  }
}
