import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

/** Як часто перевіряти, чи пора синхронізувати дзеркала (інтервал самої синхронізації — з налаштувань). */
const CATALOG_DUE_EVERY_MS = 15 * 60_000;
/** Як часто шукати замовлення, яким настав `nextPollAt` (інтервал опитування — з налаштувань). */
const POLL_DUE_EVERY_MS = 5 * 60_000;
/** Як часто перепоставляти загублені задачі й чистити старі пропозиції. */
const SWEEP_EVERY_MS = 5 * 60_000;

/**
 * Повторювані задачі постачальників API. Одна задача на чергу для всіх організацій: інтервали
 * організацій (`supplierCatalogSyncIntervalMinutes`, `supplierOrderPollIntervalMinutes`)
 * перевіряє сам обробник, тож зміна налаштування не потребує перепланування.
 * Redis недоступний на старті — лог і далі без розкладу (offline-first: API не падає).
 */
@Injectable()
export class SupplierApiScheduler implements OnModuleInit {
  private readonly logger = new Logger(SupplierApiScheduler.name);

  constructor(
    @InjectQueue('supplier-catalog') private readonly catalogQueue: Queue,
    @InjectQueue('supplier-order') private readonly orderQueue: Queue,
    @InjectQueue('supplier-maintenance') private readonly maintenanceQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await Promise.all([this.scheduleCatalog(), this.schedulePolling(), this.scheduleSweep()]);
  }

  private warn(what: string) {
    return (e: unknown) =>
      this.logger.warn(`${what} не зареєстровано: ${e instanceof Error ? e.message : e}`);
  }

  private async schedulePolling(): Promise<void> {
    await this.orderQueue
      .add(
        'poll-due',
        {},
        {
          repeat: { every: POLL_DUE_EVERY_MS },
          attempts: 10,
          backoff: { type: 'exponential', delay: 60_000 },
          jobId: 'supplier-order-poll-due',
          removeOnComplete: true,
          removeOnFail: 200,
        },
      )
      .catch(this.warn('Розклад опитування замовлень'));
  }

  private async scheduleSweep(): Promise<void> {
    await this.maintenanceQueue
      .add(
        'sweep',
        {},
        {
          repeat: { every: SWEEP_EVERY_MS },
          attempts: 10,
          backoff: { type: 'exponential', delay: 60_000 },
          jobId: 'supplier-maintenance-sweep',
          removeOnComplete: true,
          removeOnFail: 200,
        },
      )
      .catch(this.warn('Розклад sweep'));
  }

  private async scheduleCatalog(): Promise<void> {
    await this.catalogQueue
      .add(
        'sync-due',
        {},
        {
          repeat: { every: CATALOG_DUE_EVERY_MS },
          attempts: 10,
          backoff: { type: 'exponential', delay: 60_000 },
          jobId: 'supplier-catalog-sync-due',
          removeOnComplete: true,
          removeOnFail: 200,
        },
      )
      .catch((e: unknown) =>
        this.logger.warn(
          `Розклад синхронізації дзеркал не зареєстровано: ${e instanceof Error ? e.message : e}`,
        ),
      );
  }
}
