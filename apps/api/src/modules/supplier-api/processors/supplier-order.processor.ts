import { Injectable } from '@nestjs/common';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { runWithTenant } from '../../../common/tenant/tenant-context';
import { DeadLetterWorkerHost } from '../../dead-letter/dead-letter-worker-host';
import { DeadLetterService } from '../../dead-letter/dead-letter.service';
import { SupplierOrderSender, type SupplierPlaceJob } from '../orders/supplier-order-sender';
import { SupplierOrderPoller } from '../orders/supplier-order-poller';

/**
 * Черга `supplier-order` (BR-SCON-009…012): `place` — відправка замовлення постачальнику по
 * кроках; `poll-now` — «Оновити статус»; `poll-due` — повторювана: статуси нетермінальних
 * замовлень за `supplierOrderPollIntervalMinutes`. У job.data лише id.
 */
@Injectable()
@Processor('supplier-order', { concurrency: 2 })
export class SupplierOrderProcessor extends DeadLetterWorkerHost {
  constructor(
    private readonly sender: SupplierOrderSender,
    private readonly poller: SupplierOrderPoller,
    deadLetter: DeadLetterService,
  ) {
    super(deadLetter);
  }

  async process(job: Job, token?: string): Promise<void> {
    if (job.name === 'poll-due') return this.poller.pollDue();
    const { orgId } = job.data as Partial<SupplierPlaceJob>;
    if (!orgId) throw new UnrecoverableError('supplier-order: job без orgId');
    await runWithTenant({ orgId }, async () => {
      if (job.name === 'place') await this.sender.run(job as Job<SupplierPlaceJob>, token);
      else if (job.name === 'poll-now')
        await this.poller.pollPurchaseOrder(job as Job<SupplierPlaceJob>, token);
      else throw new UnrecoverableError(`supplier-order: невідома задача ${job.name}`);
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): Promise<void> {
    return this.deadLetterOnFailed(job, err);
  }
}
