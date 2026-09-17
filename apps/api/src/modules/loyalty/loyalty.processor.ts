import { Processor, OnWorkerEvent } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job } from 'bullmq';
import { LoyaltyService } from './loyalty.service';
import { runWithTenant } from '../../common/tenant/tenant-context';
import { DeadLetterWorkerHost } from '../../modules/dead-letter/dead-letter-worker-host';
import { DeadLetterService } from '../../modules/dead-letter/dead-letter.service';

interface EarnJob {
  orgId: string;
  counterpartyId: string;
  paymentAmount: number;
  documentId?: string;
}

// concurrency: 3 — loyalty earn jobs are lightweight DB writes; parallelising reduces
// latency when multiple payments arrive simultaneously (e.g. bulk settlement batch).
@Injectable()
@Processor('loyalty', { concurrency: 3 })
export class LoyaltyProcessor extends DeadLetterWorkerHost {
  constructor(
    private readonly loyaltyService: LoyaltyService,
    deadLetter: DeadLetterService,
  ) {
    super(deadLetter);
  }

  async process(job: Job<EarnJob>): Promise<void> {
    return runWithTenant({ orgId: job.data.orgId }, async () => {
      const { orgId, counterpartyId, paymentAmount, documentId } = job.data;
      await this.loyaltyService.earn(orgId, counterpartyId, paymentAmount, documentId);
    });
  }

  // Централізований DLQ: терминальний провал → DeadLetterJob (аудит стеку, backend #2).
  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): Promise<void> {
    return this.deadLetterOnFailed(job, err);
  }
}
