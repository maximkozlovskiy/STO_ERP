import { Injectable, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { runWithTenant } from '../../../common/tenant/tenant-context';
import { forEachActiveOrg } from '../../../common/scheduler/for-each-active-org';
import { DeadLetterWorkerHost } from '../../dead-letter/dead-letter-worker-host';
import { DeadLetterService } from '../../dead-letter/dead-letter.service';
import { SettingsService } from '../../settings/settings.service';
import { SupplierConnectionsService } from '../connections/supplier-connections.service';
import { SupplierOffersService } from '../offers/supplier-offers.service';
import { SupplierOrdersService } from '../orders/supplier-orders.service';

/** Запит / перевірка вважаються «загубленими в черзі», якщо висять у QUEUED / PENDING довше. */
const STUCK_AFTER_MS = 2 * 60_000;
const BATCH = 200;

/**
 * Внутрішня черга `supplier-maintenance` (лише БД і Redis), задача `sweep` (BR-SCON-006,
 * BR-SOFR-003): Redis був недоступний чи процес упав між комітом і постановкою — рядок лишився
 * QUEUED / PENDING; sweep ставить його задачу знову (jobId той самий, тож живу не дублює).
 * Також — очищення пропозицій, старших за `supplierOfferRetentionDays` (soft delete).
 */
@Injectable()
@Processor('supplier-maintenance', { concurrency: 1 })
export class SupplierMaintenanceProcessor extends DeadLetterWorkerHost {
  private readonly logger = new Logger(SupplierMaintenanceProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly connections: SupplierConnectionsService,
    private readonly offers: SupplierOffersService,
    private readonly orders: SupplierOrdersService,
    deadLetter: DeadLetterService,
  ) {
    super(deadLetter);
  }

  async process(job: Job): Promise<void> {
    if (job.name !== 'sweep') return;
    await forEachActiveOrg(this.prisma, async orgIds => {
      for (const orgId of orgIds) {
        await runWithTenant({ orgId }, () => this.sweepOrg(orgId));
      }
    });
  }

  async sweepOrg(orgId: string): Promise<void> {
    const stuckBefore = new Date(Date.now() - STUCK_AFTER_MS);
    const [requests, verifies, queuedPos] = await Promise.all([
      this.prisma.supplierOfferRequest.findMany({
        where: { orgId, status: 'QUEUED', deletedAt: null, createdAt: { lt: stuckBefore } },
        select: { id: true },
        take: BATCH,
      }),
      this.prisma.supplierConnection.findMany({
        where: {
          orgId,
          verifyStatus: 'PENDING',
          deletedAt: null,
          verifyRequestedAt: { lt: stuckBefore },
        },
        select: { id: true, verifyRequestedAt: true },
        take: BATCH,
      }),
      this.prisma.purchaseOrder.findMany({
        where: {
          orgId,
          supplierApiStatus: 'QUEUED',
          deletedAt: null,
          updatedAt: { lt: stuckBefore },
        },
        select: { id: true },
        take: BATCH,
      }),
    ]);
    // Пошуки й відправки — одним addBulk кожні, а не окремим add на рядок.
    await this.offers.enqueueSearchMany(
      orgId,
      requests.map(r => r.id),
    );
    for (const c of verifies) {
      await this.connections.enqueueVerify(orgId, c.id, c.verifyRequestedAt ?? new Date());
    }
    await this.orders.enqueuePlaceMany(
      orgId,
      queuedPos.map(po => po.id),
    );

    const s = await this.settings.getOrganisationSettings(orgId);
    const cutoff = new Date(Date.now() - s.supplierOfferRetentionDays * 86_400_000);
    const [offers] = await Promise.all([
      this.prisma.supplierOffer.updateMany({
        where: { orgId, deletedAt: null, fetchedAt: { lt: cutoff } },
        data: { deletedAt: new Date() },
      }),
      this.prisma.supplierOfferRequest.updateMany({
        where: {
          orgId,
          deletedAt: null,
          createdAt: { lt: cutoff },
          status: { in: ['DONE', 'FAILED'] },
        },
        data: { deletedAt: new Date() },
      }),
    ]);
    if (requests.length + verifies.length + queuedPos.length + offers.count > 0) {
      this.logger.log(
        `sweep ${orgId}: пошуків ${requests.length}, перевірок ${verifies.length}, замовлень ${queuedPos.length}, знято пропозицій ${offers.count}`,
      );
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): Promise<void> {
    return this.deadLetterOnFailed(job, err);
  }
}
