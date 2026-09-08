import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { forEachActiveOrg } from '../../common/scheduler/for-each-active-org';

@Injectable()
export class FollowUpScheduler implements OnModuleInit {
  private readonly logger = new Logger(FollowUpScheduler.name);

  constructor(
    @InjectQueue('followup') private readonly followUpQueue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    // Усі активні організації через cursor-пагінацію (Bug #107 — cloud >1000 орг
    // раніше тихо не охоплювались). BullMQ дедуплікує repeatable за jobId → add()
    // ідемпотентний на рестарті (Bug #108). Fires 09:00 Kyiv (DST via tz).
    // Parallel fan-out у межах батча: queue.add — незалежний Redis RTT на org.
    const total = await forEachActiveOrg(
      this.prisma,
      async orgIds => {
        await Promise.all(
          orgIds.map(orgId =>
            this.followUpQueue.add(
              'send-reminders',
              { orgId },
              {
                repeat: { pattern: '0 9 * * *', tz: 'Europe/Kyiv' },
                attempts: 10,
                backoff: { type: 'exponential', delay: 60_000 },
                jobId: `followup-${orgId}`,
                removeOnComplete: true,
                // F1: repeatable job — без cap failed-set у Redis росте безмежно (offline-БД на ПК СТО).
                removeOnFail: 200,
              },
            ),
          ),
        );
      },
      { logger: this.logger },
    );

    this.logger.log(`FollowUp CRON зареєстровано для ${total} організацій`);
  }
}
