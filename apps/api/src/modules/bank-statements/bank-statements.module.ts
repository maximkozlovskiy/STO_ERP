import { Module } from '@nestjs/common';
import { ExchangeRatesModule } from '../exchange-rates/exchange-rates.module';
import { PaymentsModule } from '../payments/payments.module';
import { BankReconciliationService } from './bank-reconciliation.service';
import { BankStatementParserService } from './bank-statement-parser.service';
import { BankStatementsController } from './bank-statements.controller';

// PrismaModule — @Global (не імпортуємо). ExchangeRatesModule — конвертація amountBase виписки у base.
// PaymentsModule — інжектимо PaymentsService (створення Payment при рознесенні транзакції).
@Module({
  imports: [ExchangeRatesModule, PaymentsModule],
  controllers: [BankStatementsController],
  providers: [BankReconciliationService, BankStatementParserService],
  exports: [BankReconciliationService],
})
export class BankStatementsModule {}
