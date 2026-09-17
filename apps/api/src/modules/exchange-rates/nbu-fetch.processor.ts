import { Processor, OnWorkerEvent } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { NbuFetchService } from './nbu-fetch.service';
import { runWithTenant } from '../../common/tenant/tenant-context';
import { DeadLetterWorkerHost } from '../../modules/dead-letter/dead-letter-worker-host';
import { DeadLetterService } from '../../modules/dead-letter/dead-letter.service';

export interface NbuFetchJob {
  orgId: string;
}

@Injectable()
@Processor('nbu-fetch', { concurrency: 2 })
export class NbuFetchProcessor extends DeadLetterWorkerHost {
  private readonly logger = new Logger(NbuFetchProcessor.name);

  constructor(
    private readonly nbuFetchService: NbuFetchService,
    deadLetter: DeadLetterService,
  ) {
    super(deadLetter);
  }

  async process(job: Job<NbuFetchJob>): Promise<void> {
    return runWithTenant({ orgId: job.data.orgId }, async () => {
      const { orgId } = job.data;
      const result = await this.nbuFetchService.fetchAndUpsertForOrg(orgId);
      this.logger.log(`NBU fetch завершено org=${orgId}: ${JSON.stringify(result)}`);
    });
  }

  // Централізований DLQ: терминальний провал → DeadLetterJob (аудит стеку, backend #2).
  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): Promise<void> {
    return this.deadLetterOnFailed(job, err);
  }
}
