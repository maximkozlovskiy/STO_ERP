import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { OutboundWebhookProcessor } from './webhooks.processor';
import { PrismaModule } from '../../prisma/prisma.module';
import { DEFAULT_JOB_OPTS } from '../../common/scheduler/job-opts';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({ name: 'outbound-webhook', defaultJobOptions: DEFAULT_JOB_OPTS }),
  ],
  controllers: [WebhooksController],
  providers: [WebhooksService, OutboundWebhookProcessor],
  exports: [WebhooksService],
})
export class WebhooksModule {}
