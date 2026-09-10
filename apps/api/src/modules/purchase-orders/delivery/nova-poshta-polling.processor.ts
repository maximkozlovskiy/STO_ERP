import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { DeliveryStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { runWithTenant } from '../../../common/tenant/tenant-context';
import { ProviderConfigService } from '../../payments/provider-config.service';
import { DeliveryProviderRegistry } from './delivery-provider-registry';
import { DeliveryTrackingService } from './delivery-tracking.service';
import { IntegrationLogService } from '../../integration-logs/integration-log.service';

interface PollJob {
  purchaseOrderId: string;
  orgId: string;
  pollAttempts?: number;
}

// Стеля опитувань — щоб «зависла» накладна не крутилась вічно. 480 × 30хв ≈ 10 днів.
const MAX_POLL_ATTEMPTS = 480;

// Термінальні статуси доставки — на них опитування зупиняється.
const TERMINAL: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>([
  'DELIVERED',
  'RETURNED',
  'NOT_FOUND',
]);

/**
 * Опитує статус доставки PurchaseOrder за номером накладної через активну службу доставки.
 * Self-re-enqueue з delay = OrganisationSettings.deliveryPollIntervalMinutes (НЕ hardcoded).
 * jobId-дедуп (`np-poll-<poId>`) — single-flight на документ. Зупинка: термінальний статус,
 * зникнення ЕН, видалення PO, або MAX_POLL_ATTEMPTS. Оновлює лише delivery-метадані (НЕ FSM закупівлі).
 */
@Injectable()
@Processor('nova-poshta-polling', { concurrency: 3 })
export class NovaPoshtaPollingProcessor extends WorkerHost {
  private readonly logger = new Logger(NovaPoshtaPollingProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerConfig: ProviderConfigService,
    private readonly registry: DeliveryProviderRegistry,
    private readonly tracking: DeliveryTrackingService,
    @InjectQueue('nova-poshta-polling') private readonly pollQueue: Queue,
    private readonly integrationLog: IntegrationLogService,
  ) {
    super();
  }

  async process(job: Job<PollJob>): Promise<void> {
    return runWithTenant({ orgId: job.data.orgId }, async () => {
      const { purchaseOrderId, orgId, pollAttempts = 0 } = job.data;

      const po = await this.prisma.purchaseOrder.findFirst({
        where: { id: purchaseOrderId, orgId, deletedAt: null },
        select: {
          trackingNumber: true,
          deliveryStatus: true,
          warehouse: { select: { branchId: true } },
        },
      });
      if (!po) return; // видалено — стоп
      if (!po.trackingNumber) return; // ЕН прибрали → трекінг більше не потрібен, стоп
      if (po.deliveryStatus && TERMINAL.has(po.deliveryStatus)) return; // термінальний — стоп

      // Активна служба доставки для філії складу (з legacy-fallback у provider-config — тут null-safe).
      const branchId = po.warehouse?.branchId ?? null;
      const active = await this.providerConfig.resolveActive(orgId, branchId, 'DELIVERY');
      if (!active) {
        // Служба доставки не налаштована → не FAILED (це конфіг-стан). Не re-enqueue: коли ключ
        // введуть і збережуть ЕН — enqueueInitial поставить новий job.
        this.logger.debug(
          `Служба доставки не налаштована для org=${orgId}, пропускаємо PO=${purchaseOrderId}`,
        );
        return;
      }
      const provider = this.registry.get(active.provider);
      if (!provider) return;

      let result;
      try {
        result = await this.integrationLog.wrap(
          {
            orgId,
            branchId,
            provider: active.provider,
            operation: 'getStatus',
            documentType: 'PurchaseOrder',
            documentId: purchaseOrderId,
          },
          () =>
            provider.getStatus(
              { apiUrl: active.apiUrl, credentials: active.credentials },
              po.trackingNumber!,
            ),
        );
      } catch (e) {
        // Транзієнтна помилка (НП недоступна/timeout) → re-enqueue (з cap), не зупиняємо трекінг.
        this.logger.warn(
          `Трекінг PO=${purchaseOrderId}: помилка опитування — ${e instanceof Error ? e.message : e}`,
        );
        await this.reEnqueue(orgId, purchaseOrderId, pollAttempts);
        return;
      }

      // Оновлюємо статус лише якщо змінився (менше write-ів + коректний updatedAt).
      if (result.status !== po.deliveryStatus) {
        await this.prisma.purchaseOrder
          .updateMany({
            // deletedAt:null у where — PO міг бути soft-deleted між read і write;
            // updateMany з compound-фільтром просто зачепить 0 рядків (не резурект delivery-метадані).
            where: { id: purchaseOrderId, orgId, deletedAt: null },
            data: {
              deliveryStatus: result.status,
              deliveryStatusRaw: result.raw.slice(0, 300),
              deliveryStatusUpdatedAt: new Date(),
            },
          })
          .catch((e: unknown) =>
            this.logger.error(
              `Не вдалось оновити статус доставки PO=${purchaseOrderId}: ${e instanceof Error ? e.message : e}`,
            ),
          );
      }

      if (TERMINAL.has(result.status)) {
        this.logger.log(`Трекінг PO=${purchaseOrderId} завершено: ${result.status}`);
        return; // термінальний — стоп
      }
      await this.reEnqueue(orgId, purchaseOrderId, pollAttempts);
    });
  }

  /** Re-enqueue з delay з налаштувань + cap на кількість спроб. */
  private async reEnqueue(
    orgId: string,
    purchaseOrderId: string,
    pollAttempts: number,
  ): Promise<void> {
    const next = pollAttempts + 1;
    if (next > MAX_POLL_ATTEMPTS) {
      this.logger.warn(
        `Трекінг PO=${purchaseOrderId}: вичерпано ${MAX_POLL_ATTEMPTS} спроб — зупинка (накладна не досягла термінального статусу)`,
      );
      return;
    }
    const delay = await this.tracking.pollDelayMs(orgId);
    await this.pollQueue
      .add(
        'poll',
        { purchaseOrderId, orgId, pollAttempts: next },
        { delay, jobId: `np-poll-${purchaseOrderId}`, removeOnComplete: true, removeOnFail: 200 },
      )
      .catch(() => undefined);
  }
}
