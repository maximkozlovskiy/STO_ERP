import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { LoyaltyService } from './loyalty.service';

interface EarnJob {
  orgId: string;
  counterpartyId: string;
  paymentAmount: number;
  documentId?: string;
}

@Processor('loyalty')
export class LoyaltyProcessor {
  constructor(private readonly loyaltyService: LoyaltyService) {}

  @Process('earn')
  async handleEarn(job: Job<EarnJob>): Promise<void> {
    const { orgId, counterpartyId, paymentAmount, documentId } = job.data;
    await this.loyaltyService.earn(orgId, counterpartyId, paymentAmount, documentId);
  }
}
