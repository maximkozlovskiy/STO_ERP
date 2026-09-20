import { Module } from '@nestjs/common';
import { ExchangeRatesModule } from '../exchange-rates/exchange-rates.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { AuditModule } from '../audit/audit.module';
import { BankStatementPullModule } from '../bank-statements/bank-statement-pull.module';

@Module({
  // BankStatementPullModule (ЛЕАФ) — reschedule-хук pull-виписки при зміні інтервалу.
  // Імпортуємо саме леаф, НЕ важкий BankStatementsModule (уникнення циклу залежностей).
  imports: [ExchangeRatesModule, AuditModule, BankStatementPullModule], // C1b: аудит org/branch/taxRate settings
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
