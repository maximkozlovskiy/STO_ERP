import { Module } from '@nestjs/common';
import { XlsxController } from './xlsx.controller';
import { XlsxService } from './xlsx.service';
import { DocumentGridParserService } from './document-grid-parser.service';
import { OcrWorkerLifecycle } from './ocr-text-layer.provider';
import { GoodsModule } from '../goods/goods.module';
import { BrandsModule } from '../brands/brands.module';
import { UnitsModule } from '../units/units.module';
import { WorksModule } from '../works/works.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SettingsModule } from '../settings/settings.module';
import { ExchangeRatesModule } from '../exchange-rates/exchange-rates.module';
import { WorkOrderTotalsModule } from '../work-orders/work-order-totals.module';
import {
  DocumentLineImportAdapterRegistry,
  PurchaseOrderImportAdapter,
  StockDocumentImportAdapter,
} from './document-line-import.adapter';

@Module({
  imports: [
    GoodsModule,
    BrandsModule,
    UnitsModule,
    WorksModule,
    InventoryModule,
    SettingsModule,
    ExchangeRatesModule,
    WorkOrderTotalsModule,
  ],
  controllers: [XlsxController],
  providers: [
    XlsxService,
    DocumentGridParserService,
    // Власник lifecycle OCR-воркера: без нього onModuleDestroy не викликається, живий
    // worker_threads не дає процесу завершитись на SIGTERM, і docker stop чекає 10с до SIGKILL.
    OcrWorkerLifecycle,
    PurchaseOrderImportAdapter,
    StockDocumentImportAdapter,
    DocumentLineImportAdapterRegistry,
  ],
})
export class XlsxModule {}
