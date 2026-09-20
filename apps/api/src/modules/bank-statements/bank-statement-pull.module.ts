import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DEFAULT_JOB_OPTS } from '../../common/scheduler/job-opts';
import { BankStatementPullScheduler } from './bank-statement-pull.scheduler';

/**
 * ЛЕАФ-модуль auto-pull банк-виписки: лише scheduler + черга (PrismaModule @Global).
 *
 * НАВМИСНО легкий: SettingsModule імпортує саме цей леаф (для reschedule-хука при зміні
 * bankStatementPollIntervalMinutes), а НЕ важкий BankStatementsModule — той тягне PaymentsModule
 * (→ SettlementsModule → ...), що замкнуло б цикл SettingsModule ↔ BankStatementsModule.
 * Processor живе у BankStatementsModule (йому потрібні reconciliation/registry/ProviderConfig).
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: 'bank-statement-polling',
      defaultJobOptions: DEFAULT_JOB_OPTS,
    }),
  ],
  providers: [BankStatementPullScheduler],
  exports: [BankStatementPullScheduler],
})
export class BankStatementPullModule {}
