import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SettingsService } from '../../settings/settings.service';

// Межі інтервалу опитування (хв) — clamp проти 0/негативних/надто рідкісних значень.
const MIN_POLL_MINUTES = 5;
const MAX_POLL_MINUTES = 1440;
const DEFAULT_POLL_MINUTES = 30;

/** Стани задачі, у яких ланцюжок опитування документа ще «живий». */
const LIVE_JOB_STATES = ['active', 'waiting', 'delayed', 'prioritized'] as const;

/**
 * id задачі опитування. Крок 0 (`enqueueInitial`) — `np-poll-<poId>`, далі кожен наступний крок
 * має ВЛАСНИЙ id `np-poll-<poId>-p<N>`. BullMQ мовчки відкидає `add` з id задачі, що ще існує, а
 * активна задача існує, доки не завершився її `process`, — тому з одним id на документ наступне
 * опитування не ставилось ніколи: накладна опитувалась рівно раз (той самий дефект, що Bug #804 в
 * онлайн-оплаті). Номер кроку детермінований: дубль того самого кроку, як і раніше, зливається.
 */
export function npPollJobId(purchaseOrderId: string, step: number): string {
  return step === 0 ? `np-poll-${purchaseOrderId}` : `np-poll-${purchaseOrderId}-p${step}`;
}

/**
 * Керує enqueue-ом опитування статусу доставки для PurchaseOrder. Викликається з
 * PurchaseOrdersService при вказанні/зміні номера накладної (trackingNumber). Single-flight на
 * документ: новий ланцюжок стартує, лише коли живого немає (`enqueueInitial`), а кроки ланцюжка
 * мають детерміновані id (`npPollJobId`). Інтервал — з OrganisationSettings
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
   *
   * Single-flight: якщо ланцюжок цього документа вже живий, другий не ставимо — задача ланцюжка
   * сама перечитує ЕН з БД. Відкладену задачу переводимо в «зараз» (`promote`), щоб новий ЕН
   * опитався одразу, а не через інтервал; активна задача, що опитувала старий ЕН, побачить зміну
   * при записі статусу і поставить наступний крок без затримки (процесор).
   */
  async enqueueInitial(orgId: string, purchaseOrderId: string): Promise<void> {
    if (await this.resumeLiveChain(purchaseOrderId)) return;
    await this.pollQueue
      .add(
        'poll',
        { purchaseOrderId, orgId },
        { jobId: npPollJobId(purchaseOrderId, 0), removeOnComplete: true, removeOnFail: 200 },
      )
      .catch((e: unknown) =>
        this.logger.warn(
          `Черга недоступна — трекінг ${purchaseOrderId} не поставлено: ${
            e instanceof Error ? e.message : e
          }`,
        ),
      );
  }

  /**
   * Чи є живий ланцюжок опитування документа; відкладену задачу ланцюжка — у «зараз».
   * Помилка черги → false (далі `add`, який так само offline-safe).
   */
  private async resumeLiveChain(purchaseOrderId: string): Promise<boolean> {
    try {
      const jobs = await this.pollQueue.getJobs([...LIVE_JOB_STATES]);
      const live = jobs.filter(
        j =>
          (j?.data as { purchaseOrderId?: string } | undefined)?.purchaseOrderId ===
          purchaseOrderId,
      );
      if (live.length === 0) return false;
      for (const job of live) {
        if (await job.isDelayed()) await job.promote().catch(() => undefined);
      }
      return true;
    } catch {
      return false;
    }
  }
}
