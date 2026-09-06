import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { SettingsModule } from '../settings/settings.module';
import { ProviderConfigService } from '../payments/provider-config.service';
import { NovaPoshtaClient } from './delivery/nova-poshta.client';
import { NovaPoshtaProvider } from './delivery/nova-poshta.provider';
import { DeliveryProviderRegistry } from './delivery/delivery-provider-registry';
import { DeliveryTrackingService } from './delivery/delivery-tracking.service';
import { NovaPoshtaPollingProcessor } from './delivery/nova-poshta-polling.processor';
import { DeliveryProvidersController } from './delivery/delivery-providers.controller';

@Module({
  imports: [
    InventoryModule,
    SettlementsModule,
    SettingsModule,
    BullModule.registerQueue({ name: 'nova-poshta-polling' }),
  ],
  controllers: [PurchaseOrdersController, DeliveryProvidersController],
  providers: [
    PurchaseOrdersService,
    // Служба доставки (Нова Пошта) — registry + polling + config.
    ProviderConfigService,
    NovaPoshtaClient,
    NovaPoshtaProvider,
    DeliveryProviderRegistry,
    DeliveryTrackingService,
    NovaPoshtaPollingProcessor,
  ],
})
export class PurchaseOrdersModule {}
