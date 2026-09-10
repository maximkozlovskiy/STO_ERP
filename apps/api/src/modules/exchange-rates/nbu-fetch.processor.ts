import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { NbuFetchService } from './nbu-fetch.service';
import { runWithTenant } from '../../common/tenant/tenant-context';

export interface NbuFetchJob {
  orgId: string;
}

@Injectable()
@Processor('nbu-fetch', { concurrency: 2 })
export class NbuFetchProcessor extends WorkerHost {
  private readonly logger = new Logger(NbuFetchProcessor.name);

  constructor(private readonly nbuFetchService: NbuFetchService) {
    super();
  }

  async process(job: Job<NbuFetchJob>): Promise<void> {
    return runWithTenant({ orgId: job.data.orgId }, async () => {
      const { orgId } = job.data;
      const result = await this.nbuFetchService.fetchAndUpsertForOrg(orgId);
      this.logger.log(`NBU fetch завершено org=${orgId}: ${JSON.stringify(result)}`);
    });
  }
}
