import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { DEFAULT_JOB_OPTS } from '../../common/scheduler/job-opts';
import { ExchangeRatesController } from './exchange-rates.controller';
import { ExchangeRatesService } from './exchange-rates.service';
import { NbuFetchProcessor } from './nbu-fetch.processor';
import { NbuFetchScheduler } from './nbu-fetch.scheduler';
import { NbuFetchService } from './nbu-fetch.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'nbu-fetch', defaultJobOptions: DEFAULT_JOB_OPTS })],
  controllers: [ExchangeRatesController],
  providers: [ExchangeRatesService, NbuFetchService, NbuFetchScheduler, NbuFetchProcessor],
  exports: [ExchangeRatesService, NbuFetchScheduler],
})
export class ExchangeRatesModule {}
