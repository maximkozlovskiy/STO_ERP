import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DEFAULT_JOB_OPTS } from '../../common/scheduler/job-opts';
import { IntegrationLogsModule } from '../integration-logs/integration-logs.module';
import { SettingsModule } from '../settings/settings.module';
import { ExchangeRatesModule } from '../exchange-rates/exchange-rates.module';
import { GoodMatcherModule } from '../goods/good-matcher.module';
import { GoodsModule } from '../goods/goods.module';
import { BrandsModule } from '../brands/brands.module';
import { SupplierUrlPolicy } from './http/supplier-url-policy';
import { SupplierRateLimiter } from './http/supplier-rate-limiter';
import { SupplierHttpClient } from './http/supplier-http.client';
import { SupplierAuthSession } from './auth/supplier-auth.session';
import { SUPPLIER_ADAPTERS } from './adapters/supplier-adapter.interface';
import { SupplierAdapterRegistry } from './adapters/supplier-adapter-registry';
import { AvdTradeAdapter } from './adapters/avd-trade/avd-trade.adapter';
import { UtrAdapter } from './adapters/utr/utr.adapter';
import { BmPartsAdapter } from './adapters/bm-parts/bm-parts.adapter';
import { TehnomirAdapter } from './adapters/tehnomir/tehnomir.adapter';
import { AdUkraineAdapter } from './adapters/ad-ukraine/ad-ukraine.adapter';
import { SupplierConnectionsService } from './connections/supplier-connections.service';
import {
  SupplierConnectionsController,
  SupplierProvidersController,
} from './connections/supplier-connections.controller';
import { SupplierSearchProcessor } from './processors/supplier-search.processor';
import { SupplierCatalogService } from './catalog/supplier-catalog.service';
import { SupplierPriceConverter } from './offers/supplier-price-converter';
import { SupplierOffersService } from './offers/supplier-offers.service';
import { SupplierOfferSearchWorker } from './offers/supplier-offer-search.worker';
import { SupplierAllocationService } from './strategy/supplier-allocation.service';
import { SupplierCatalogProcessor } from './processors/supplier-catalog.processor';
import { SupplierApiScheduler } from './supplier-api.scheduler';
import {
  SupplierItemOffersController,
  SupplierOffersController,
} from './offers/supplier-offers.controller';

/**
 * Постачальники API (docs/objects/supplier-connection.md, supplier-offer.md). Зовнішні виклики —
 * лише з обробників черг `supplier-search`, `supplier-order`, `supplier-catalog` (ADR-005);
 * `supplier-maintenance` — внутрішня (перепостановка, очищення).
 */
@Module({
  imports: [
    IntegrationLogsModule,
    SettingsModule,
    ExchangeRatesModule,
    GoodMatcherModule,
    GoodsModule,
    BrandsModule,
    BullModule.registerQueue({ name: 'supplier-search', defaultJobOptions: DEFAULT_JOB_OPTS }),
    BullModule.registerQueue({ name: 'supplier-order', defaultJobOptions: DEFAULT_JOB_OPTS }),
    BullModule.registerQueue({ name: 'supplier-catalog', defaultJobOptions: DEFAULT_JOB_OPTS }),
    BullModule.registerQueue({ name: 'supplier-maintenance', defaultJobOptions: DEFAULT_JOB_OPTS }),
  ],
  controllers: [
    SupplierProvidersController,
    SupplierConnectionsController,
    SupplierOffersController,
    SupplierItemOffersController,
  ],
  providers: [
    // У production непорожній SUPPLIER_API_DEV_ALLOWED_ORIGINS валить старт (і env.schema).
    { provide: SupplierUrlPolicy, useFactory: () => SupplierUrlPolicy.fromEnv(process.env) },
    SupplierRateLimiter,
    SupplierHttpClient,
    SupplierAuthSession,
    AvdTradeAdapter,
    UtrAdapter,
    BmPartsAdapter,
    TehnomirAdapter,
    AdUkraineAdapter,
    {
      provide: SUPPLIER_ADAPTERS,
      useFactory: (
        avd: AvdTradeAdapter,
        utr: UtrAdapter,
        bm: BmPartsAdapter,
        tehnomir: TehnomirAdapter,
        ad: AdUkraineAdapter,
      ) => [avd, utr, bm, tehnomir, ad],
      inject: [AvdTradeAdapter, UtrAdapter, BmPartsAdapter, TehnomirAdapter, AdUkraineAdapter],
    },
    SupplierAdapterRegistry,
    SupplierConnectionsService,
    SupplierCatalogService,
    SupplierPriceConverter,
    SupplierOffersService,
    SupplierOfferSearchWorker,
    SupplierAllocationService,
    SupplierSearchProcessor,
    SupplierCatalogProcessor,
    SupplierApiScheduler,
  ],
  exports: [SupplierAdapterRegistry],
})
export class SupplierApiModule {}
