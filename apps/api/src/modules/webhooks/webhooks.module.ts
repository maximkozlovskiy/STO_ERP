import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { OutboundWebhookProcessor } from './webhooks.processor';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({ name: 'outbound-webhook' }),
  ],
  controllers: [WebhooksController],
  providers: [WebhooksService, OutboundWebhookProcessor],
  exports: [WebhooksService],
})
export class WebhooksModule {}
