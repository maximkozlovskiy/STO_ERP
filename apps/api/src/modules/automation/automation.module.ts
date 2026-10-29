import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { DEFAULT_JOB_OPTS } from '../../common/scheduler/job-opts';
import { AutomationEventsProcessor } from './automation-events.processor';
import { AutomationEventsScheduler } from './automation-events.scheduler';
import { DOMAIN_EVENT_HANDLERS, type DomainEventHandler } from './domain-event-handler';
import { TasksModule } from '../tasks/tasks.module';
import { AutomationActionsService } from './automation-actions.service';
import { AutomationContextService } from './automation-context.service';
import { AutomationEngine } from './automation-engine';
import { AutomationRulesService } from './automation-rules.service';
import { EmployeeNotificationsService } from './employee-notifications.service';
import { AutomationController, EmployeeNotificationsController } from './automation.controller';

/**
 * Автоматизація (docs/objects/automation.md). Блок 1 — outbox `DomainEvent`: подію пише
 * `recordDocumentEvent(tx, …)` у транзакції документа (плоска функція, без DI — модулі документів
 * цей модуль не імпортують), обробляє job `automation-events` (BR-AUT-060/061). Блок 2 — двигун
 * правил (`AutomationEngine`, обробник outbox), три дії, API правил, журналу й дзвіночка.
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: 'automation-events', defaultJobOptions: DEFAULT_JOB_OPTS }),
    TasksModule,
  ],
  controllers: [AutomationController, EmployeeNotificationsController],
  providers: [
    AutomationContextService,
    AutomationActionsService,
    AutomationEngine,
    AutomationRulesService,
    EmployeeNotificationsService,
    {
      provide: DOMAIN_EVENT_HANDLERS,
      useFactory: (engine: AutomationEngine): DomainEventHandler[] => [engine],
      inject: [AutomationEngine],
    },
    AutomationEventsProcessor,
    AutomationEventsScheduler,
  ],
})
export class AutomationModule {}
