import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

/** Як часто job бере необроблені події outbox (BR-AUT-061). */
export const AUTOMATION_EVENTS_EVERY_MS = 10_000;

/**
 * Один глобальний повторюваний job (не per-org): вибірка подій крос-організаційна, кожна подія
 * обробляється в scope своєї організації. `jobId` — дедуп на рестарті; `attempts: 1` — збійний
 * прохід повторить наступний тік, а не retry самого job-а.
 */
@Injectable()
export class AutomationEventsScheduler implements OnModuleInit {
  private readonly logger = new Logger(AutomationEventsScheduler.name);

  constructor(@InjectQueue('automation-events') private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.add(
      'process',
      {},
      {
        repeat: { every: AUTOMATION_EVENTS_EVERY_MS },
        attempts: 1,
        jobId: 'automation-events',
      },
    );
    this.logger.log(
      `automation-events зареєстровано (кожні ${AUTOMATION_EVENTS_EVERY_MS / 1000} с)`,
    );
  }
}
