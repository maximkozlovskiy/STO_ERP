import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DEFAULT_JOB_OPTS } from '../common/scheduler/job-opts';
import { HealthController } from './health.controller';

@Module({
  imports: [BullModule.registerQueue({ name: 'sms', defaultJobOptions: DEFAULT_JOB_OPTS })],
  controllers: [HealthController],
})
export class HealthModule {}
