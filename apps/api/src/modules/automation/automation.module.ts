import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { DEFAULT_JOB_OPTS } from '../../common/scheduler/job-opts';
import { AutomationEventsProcessor } from './automation-events.processor';
import { AutomationEventsScheduler } from './automation-events.scheduler';
import { DOMAIN_EVENT_HANDLERS, type DomainEventHandler } from './domain-event-handler';

/**
 * Автоматизація (docs/objects/automation.md). Блок 1 — outbox `DomainEvent`: подію пише
 * `recordDocumentEvent(tx, …)` у транзакції документа (плоска функція, без DI — модулі документів
 * цей модуль не імпортують), обробляє job `automation-events` (BR-AUT-060/061).
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: 'automation-events', defaultJobOptions: DEFAULT_JOB_OPTS }),
  ],
  providers: [
    // Двигун правил (блок 2) додасть сюди свій обробник.
    { provide: DOMAIN_EVENT_HANDLERS, useValue: [] satisfies DomainEventHandler[] },
    AutomationEventsProcessor,
    AutomationEventsScheduler,
  ],
})
export class AutomationModule {}
