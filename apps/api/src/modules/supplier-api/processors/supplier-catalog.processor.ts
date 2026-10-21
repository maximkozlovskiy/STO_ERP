import { Injectable, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { runWithTenant } from '../../../common/tenant/tenant-context';
import { forEachActiveOrg } from '../../../common/scheduler/for-each-active-org';
import { DeadLetterWorkerHost } from '../../dead-letter/dead-letter-worker-host';
import { DeadLetterService } from '../../dead-letter/dead-letter.service';
import { IntegrationLogService } from '../../integration-logs/integration-log.service';
import { SettingsService } from '../../settings/settings.service';
import { SupplierAdapterRegistry } from '../adapters/supplier-adapter-registry';
import { SupplierCatalogService } from '../catalog/supplier-catalog.service';
import { loadConnection, toConnectionContext } from '../connections/supplier-connection-context';
import { handleSupplierJobError } from './supplier-job-errors';

export interface SupplierCatalogJob {
  orgId: string;
  connectionId: string;
}

/**
 * Черга `supplier-catalog` (BR-SCON-015): `sync` — повна синхронізація дзеркала каталогу
 * підключення (AVD); `sync-due` — повторювана: ставить `sync` підключенням, у яких дзеркало
 * старше `supplierCatalogSyncIntervalMinutes`.
 */
@Injectable()
@Processor('supplier-catalog', { concurrency: 1 })
export class SupplierCatalogProcessor extends DeadLetterWorkerHost {
  private readonly logger = new Logger(SupplierCatalogProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SupplierAdapterRegistry,
    private readonly catalog: SupplierCatalogService,
    private readonly settings: SettingsService,
    private readonly integrationLog: IntegrationLogService,
    deadLetter: DeadLetterService,
  ) {
    super(deadLetter);
  }

  async process(job: Job, token?: string): Promise<void> {
    if (job.name === 'sync-due') return this.syncDue();
    if (job.name !== 'sync')
      throw new UnrecoverableError(`supplier-catalog: невідома задача ${job.name}`);
    const { orgId } = job.data as SupplierCatalogJob;
    if (!orgId) throw new UnrecoverableError('supplier-catalog: job без orgId');
    await runWithTenant({ orgId }, async () => this.sync(job as Job<SupplierCatalogJob>, token));
  }

  private async sync(job: Job<SupplierCatalogJob>, token: string | undefined): Promise<void> {
    const { orgId, connectionId } = job.data;
    const row = await loadConnection(this.prisma, orgId, connectionId);
    if (!row || !row.enabled) return;
    const conn = toConnectionContext(row);
    const adapter = this.registry.get(conn.provider);
    const syncCatalog = adapter.syncCatalog?.bind(adapter);
    if (!syncCatalog || adapter.capabilities.search !== 'mirror') return;
    await this.setStatus(orgId, connectionId, { catalogSyncStatus: 'RUNNING' });
    try {
      const res = await this.integrationLog.wrap(
        {
          orgId,
          provider: conn.provider,
          operation: 'catalogSync',
          documentType: 'SupplierConnection',
          documentId: connectionId,
        },
        () => this.catalog.sync(conn, sink => syncCatalog(conn, sink)),
      );
      await this.setStatus(orgId, connectionId, {
        catalogSyncStatus: 'OK',
        catalogSyncError: null,
        catalogSyncedAt: new Date(),
      });
      this.logger.log(`Дзеркало ${connectionId}: ${res.count} товарів, знято ${res.removed}`);
    } catch (e) {
      return handleSupplierJobError(job, token, e, {
        onFinal: message =>
          this.setStatus(orgId, connectionId, {
            catalogSyncStatus: 'FAILED',
            catalogSyncError: message,
          }),
        onRetry: message =>
          this.setStatus(orgId, connectionId, {
            catalogSyncStatus: 'RETRYING',
            catalogSyncError: message,
          }),
      });
    }
  }

  /** Повторювана: підключення з дзеркалом, старшим за інтервал організації, — у чергу. */
  private async syncDue(): Promise<void> {
    const mirror = this.registry
      .list()
      .filter(p => p.capabilities.search === 'mirror')
      .map(p => p.provider);
    if (mirror.length === 0) return;
    await forEachActiveOrg(this.prisma, async orgIds => {
      for (const orgId of orgIds) {
        await runWithTenant({ orgId }, async () => {
          const s = await this.settings.getOrganisationSettings(orgId);
          const before = new Date(Date.now() - s.supplierCatalogSyncIntervalMinutes * 60_000);
          const due = await this.prisma.supplierConnection.findMany({
            where: {
              orgId,
              provider: { in: mirror },
              enabled: true,
              deletedAt: null,
              OR: [{ catalogSyncedAt: null }, { catalogSyncedAt: { lt: before } }],
            },
            select: { id: true },
            take: 100,
          });
          await this.catalog.enqueueSyncMany(
            orgId,
            due.map(c => c.id),
          );
        });
      }
    });
  }

  private async setStatus(
    orgId: string,
    id: string,
    data: { catalogSyncStatus: string; catalogSyncError?: string | null; catalogSyncedAt?: Date },
  ): Promise<void> {
    await this.prisma.supplierConnection.updateMany({
      where: { id, orgId, deletedAt: null },
      data,
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): Promise<void> {
    return this.deadLetterOnFailed(job, err);
  }
}
