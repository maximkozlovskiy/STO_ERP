import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DEFAULT_JOB_OPTS } from '../common/scheduler/job-opts';
import { HealthController } from './health.controller';
import { FilesModule } from '../modules/files/files.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'sms', defaultJobOptions: DEFAULT_JOB_OPTS }),
    FilesModule, // D1: MinIO readiness через FilesService.healthCheck
  ],
  controllers: [HealthController],
})
export class HealthModule {}
