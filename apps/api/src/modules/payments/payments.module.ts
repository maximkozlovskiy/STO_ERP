import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { CheckboxProcessor } from './checkbox.processor';
import { CheckboxClient } from './checkbox.client';
import { CashShiftService } from './cash-shift.service';
import { CashShiftController } from './cash-shift.controller';
import { MonobankClient } from './monobank.client';
import { MonobankGateway } from './gateways/monobank.gateway';
import { LiqpayGateway } from './gateways/liqpay.gateway';
import { PaymentGatewayRegistry } from './gateways/payment-gateway-registry';
import { ProviderConfigService } from './provider-config.service';
import { OnlinePaymentService } from './online-payment.service';
import { OnlinePaymentController } from './online-payment.controller';
import { PaymentGatewaysController } from './payment-gateways.controller';
import { PaymentPollingProcessor } from './payment-polling.processor';
import { SettlementsModule } from '../settlements/settlements.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WorkOrdersModule } from '../work-orders/work-orders.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'checkbox' }),
    BullModule.registerQueue({ name: 'payment-polling' }),
    SettlementsModule,
    NotificationsModule,
    WorkOrdersModule,
    // PaymentsService queues loyalty earn (queueEarn → BullMQ → LoyaltyProcessor → loyaltyService.earn)
    // — without this import queueEarn was dead code and loyalty points were never accrued.
    LoyaltyModule,
  ],
  controllers: [
    PaymentsController,
    CashShiftController,
    OnlinePaymentController,
    PaymentGatewaysController,
  ],
  providers: [
    PaymentsService,
    CheckboxProcessor,
    CheckboxClient,
    CashShiftService,
    MonobankClient,
    MonobankGateway,
    LiqpayGateway,
    PaymentGatewayRegistry,
    ProviderConfigService,
    OnlinePaymentService,
    PaymentPollingProcessor,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
