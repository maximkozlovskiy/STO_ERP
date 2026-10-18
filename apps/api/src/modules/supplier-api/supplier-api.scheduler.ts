import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

/** Як часто перевіряти, чи пора синхронізувати дзеркала (інтервал самої синхронізації — з налаштувань). */
const CATALOG_DUE_EVERY_MS = 15 * 60_000;

/**
 * Повторювані задачі постачальників API. Одна задача на чергу для всіх організацій: інтервали
 * організацій (`supplierCatalogSyncIntervalMinutes`, `supplierOrderPollIntervalMinutes`)
 * перевіряє сам обробник, тож зміна налаштування не потребує перепланування.
 * Redis недоступний на старті — лог і далі без розкладу (offline-first: API не падає).
 */
@Injectable()
export class SupplierApiScheduler implements OnModuleInit {
  private readonly logger = new Logger(SupplierApiScheduler.name);

  constructor(@InjectQueue('supplier-catalog') private readonly catalogQueue: Queue) {}

  async onModuleInit(): Promise<void> {
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
