import { Injectable, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { runWithTenant } from '../../../common/tenant/tenant-context';
import { DeadLetterWorkerHost } from '../../dead-letter/dead-letter-worker-host';
import { DeadLetterService } from '../../dead-letter/dead-letter.service';
import { IntegrationLogService } from '../../integration-logs/integration-log.service';
import { SupplierAdapterRegistry } from '../adapters/supplier-adapter-registry';
import { loadConnection, toConnectionContext } from '../connections/supplier-connection-context';
import { handleSupplierJobError } from './supplier-job-errors';

export interface SupplierVerifyJob {
  orgId: string;
  connectionId: string;
}

/**
 * Черга `supplier-search` (BR-SCON-004, 006): `verify` — перевірка підключення; `search` —
 * пошук пропозицій (SupplierOfferSearchWorker). У job.data лише id — креди читаються з БД.
 */
@Injectable()
@Processor('supplier-search', { concurrency: 4 })
export class SupplierSearchProcessor extends DeadLetterWorkerHost {
  private readonly logger = new Logger(SupplierSearchProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SupplierAdapterRegistry,
    private readonly integrationLog: IntegrationLogService,
    deadLetter: DeadLetterService,
  ) {
    super(deadLetter);
  }

  async process(job: Job, token?: string): Promise<void> {
    const data = job.data as { orgId?: string };
    if (!data.orgId) throw new UnrecoverableError('supplier-search: job без orgId');
    await runWithTenant({ orgId: data.orgId }, async () => {
      if (job.name === 'verify') await this.verify(job as Job<SupplierVerifyJob>, token);
      else throw new UnrecoverableError(`supplier-search: невідома задача ${job.name}`);
    });
  }

  /** BR-SCON-004: OK / FAILED + lastVerifiedAt, lastError — пише обробник. */
  private async verify(job: Job<SupplierVerifyJob>, token: string | undefined): Promise<void> {
    const { orgId, connectionId } = job.data;
    const row = await loadConnection(this.prisma, orgId, connectionId);
    if (!row) return; // видалено — перевіряти нічого
    const conn = toConnectionContext(row);
    const adapter = this.registry.get(conn.provider);
    try {
      await this.integrationLog.wrap(
        {
          orgId,
          provider: conn.provider,
          operation: 'verify',
          documentType: 'SupplierConnection',
          documentId: connectionId,
        },
        () => adapter.verify(conn),
      );
    } catch (e) {
      return handleSupplierJobError(job, token, e, {
        onFinal: message => this.setVerify(orgId, connectionId, 'FAILED', message),
      });
    }
    await this.setVerify(orgId, connectionId, 'OK', null);
  }

  private async setVerify(
    orgId: string,
    id: string,
    status: 'OK' | 'FAILED',
    error: string | null,
  ): Promise<void> {
    await this.prisma.supplierConnection.updateMany({
      where: { id, orgId, deletedAt: null },
      data: {
        verifyStatus: status,
        lastError: error,
        ...(status === 'OK' ? { lastVerifiedAt: new Date() } : {}),
      },
    });
    if (status === 'FAILED') this.logger.warn(`Підключення ${id}: перевірка не пройшла — ${error}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): Promise<void> {
    return this.deadLetterOnFailed(job, err);
  }
}
