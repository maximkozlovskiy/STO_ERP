import { Module } from '@nestjs/common';
import { ExchangeRatesModule } from '../exchange-rates/exchange-rates.module';
import { PaymentsModule } from '../payments/payments.module';
import { IntegrationLogsModule } from '../integration-logs/integration-logs.module';
import { ProviderConfigService } from '../payments/provider-config.service';
import { BankReconciliationService } from './bank-reconciliation.service';
import { BankStatementParserService } from './bank-statement-parser.service';
import { BankStatementsController } from './bank-statements.controller';
import { BankStatementPullModule } from './bank-statement-pull.module';
import { BankStatementProvidersController } from './bank-statement-providers.controller';
import { BankStatementPullProcessor } from './bank-statement-pull.processor';
import { Privat24Client } from './providers/privat24.client';
import { Privat24Provider } from './providers/privat24.provider';
import { MonoStatementClient } from './providers/mono-statement.client';
import { MonobankStatementProvider } from './providers/monobank-statement.provider';
import { BankProviderRegistry } from './providers/bank-provider-registry';
import { BANK_STATEMENT_PROVIDERS } from './providers/bank-provider.interface';

// PrismaModule — @Global (не імпортуємо). ExchangeRatesModule — конвертація amountBase виписки у base.
// PaymentsModule — інжектимо PaymentsService (створення Payment при рознесенні транзакції).
// IntegrationLogsModule — логування зовнішніх обмінів Privat24 (pull/verify).
// BankStatementPullModule (ЛЕАФ) — scheduler + черга 'bank-statement-polling' (processor тут-таки).
@Module({
  imports: [ExchangeRatesModule, PaymentsModule, IntegrationLogsModule, BankStatementPullModule],
  controllers: [BankStatementsController, BankStatementProvidersController],
  providers: [
    BankReconciliationService,
    BankStatementParserService,
    // Bank auto-pull: registry + providers (Privat24, monobank) + config + processor.
    ProviderConfigService,
    Privat24Client,
    Privat24Provider,
    MonoStatementClient,
    MonobankStatementProvider,
    // Multi-provider реєстрація: реєстр інжектить BANK_STATEMENT_PROVIDERS як BankStatementProvider[].
    // ОДИН factory повертає масив singleton-ів (NestJS 10 без Angular-style multi:true).
    {
      provide: BANK_STATEMENT_PROVIDERS,
      useFactory: (privat24: Privat24Provider, mono: MonobankStatementProvider) => [privat24, mono],
      inject: [Privat24Provider, MonobankStatementProvider],
    },
    BankProviderRegistry,
    BankStatementPullProcessor,
  ],
  exports: [BankReconciliationService],
})
export class BankStatementsModule {}
