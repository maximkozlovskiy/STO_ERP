import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job } from 'bullmq';
import { LoyaltyService } from './loyalty.service';
import { runWithTenant } from '../../common/tenant/tenant-context';

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
export class LoyaltyProcessor extends WorkerHost {
  constructor(private readonly loyaltyService: LoyaltyService) {
    super();
  }

  async process(job: Job<EarnJob>): Promise<void> {
    return runWithTenant({ orgId: job.data.orgId }, async () => {
      const { orgId, counterpartyId, paymentAmount, documentId } = job.data;
      await this.loyaltyService.earn(orgId, counterpartyId, paymentAmount, documentId);
    });
  }
}
