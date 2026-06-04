import { Process, Processor } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bull';
import { NbuFetchService } from './nbu-fetch.service';

export interface NbuFetchJob {
  orgId: string;
}

@Injectable()
@Processor('nbu-fetch')
export class NbuFetchProcessor {
  private readonly logger = new Logger(NbuFetchProcessor.name);

  constructor(private readonly nbuFetchService: NbuFetchService) {}

  @Process({ name: 'fetch-rates', concurrency: 2 })
  async handleFetchRates(job: Job<NbuFetchJob>): Promise<void> {
    const { orgId } = job.data;
    const result = await this.nbuFetchService.fetchAndUpsertForOrg(orgId);
    this.logger.log(`NBU fetch завершено org=${orgId}: ${JSON.stringify(result)}`);
  }
}
