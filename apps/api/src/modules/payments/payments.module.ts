import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { CheckboxProcessor } from './checkbox.processor';
import { CheckboxClient } from './checkbox.client';
import { CheckboxProvider } from './fiscal/checkbox.provider';
import { VchasnoProvider } from './fiscal/vchasno.provider';
import { FiscalProviderRegistry } from './fiscal/fiscal-provider-registry';
import { FISCAL_PROVIDERS } from './fiscal/fiscal-provider.interface';
import { FiscalProvidersController } from './fiscal-providers.controller';
import { CashShiftService } from './cash-shift.service';
import { CashShiftController } from './cash-shift.controller';
import { MonobankClient } from './monobank.client';
import { MonobankGateway } from './gateways/monobank.gateway';
import { LiqpayGateway } from './gateways/liqpay.gateway';
import { PaymentGatewayRegistry } from './gateways/payment-gateway-registry';
import { PAYMENT_GATEWAYS } from './gateways/payment-gateway.interface';
import { ProviderConfigService } from './provider-config.service';
import { OnlinePaymentService } from './online-payment.service';
import { OnlinePaymentController } from './online-payment.controller';
import { PaymentGatewaysController } from './payment-gateways.controller';
import { PaymentPollingProcessor } from './payment-polling.processor';
import { SettlementsModule } from '../settlements/settlements.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WorkOrdersModule } from '../work-orders/work-orders.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { IntegrationLogsModule } from '../integration-logs/integration-logs.module';
import { AuditModule } from '../audit/audit.module';
import { DEFAULT_JOB_OPTS } from '../../common/scheduler/job-opts';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'checkbox', defaultJobOptions: DEFAULT_JOB_OPTS }),
    BullModule.registerQueue({ name: 'payment-polling', defaultJobOptions: DEFAULT_JOB_OPTS }),
    IntegrationLogsModule,
    SettlementsModule,
    NotificationsModule,
    WorkOrdersModule,
    // PaymentsService queues loyalty earn (queueEarn → BullMQ → LoyaltyProcessor → loyaltyService.earn)
    // — without this import queueEarn was dead code and loyalty points were never accrued.
    LoyaltyModule,
    AuditModule, // C1: аудит створення платежу
  ],
  controllers: [
    PaymentsController,
    CashShiftController,
    OnlinePaymentController,
    PaymentGatewaysController,
    FiscalProvidersController,
  ],
  providers: [
    PaymentsService,
    CheckboxProcessor,
    CheckboxClient,
    CheckboxProvider,
    VchasnoProvider,
    // Multi-provider реєстрація ПРРО: реєстр інжектить FISCAL_PROVIDERS як FiscalProvider[].
    // NestJS 10 НЕ підтримує Angular-style `multi: true` (кожен запис перезаписує токен → не iterable).
    // Канонічний патерн — ОДИН factory, що інжектить конкретні класи й повертає МАСИВ singleton-ів.
    // Додати провайдера = +клас у providers + один аргумент фабрики (реєстр не чіпається).
    {
      provide: FISCAL_PROVIDERS,
      useFactory: (checkbox: CheckboxProvider, vchasno: VchasnoProvider) => [checkbox, vchasno],
      inject: [CheckboxProvider, VchasnoProvider],
    },
    FiscalProviderRegistry,
    CashShiftService,
    MonobankClient,
    MonobankGateway,
    LiqpayGateway,
    // Multi-provider реєстрація шлюзів: реєстр інжектить PAYMENT_GATEWAYS як PaymentGateway[].
    {
      provide: PAYMENT_GATEWAYS,
      useFactory: (monobank: MonobankGateway, liqpay: LiqpayGateway) => [monobank, liqpay],
      inject: [MonobankGateway, LiqpayGateway],
    },
    PaymentGatewayRegistry,
    ProviderConfigService,
    OnlinePaymentService,
    PaymentPollingProcessor,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
