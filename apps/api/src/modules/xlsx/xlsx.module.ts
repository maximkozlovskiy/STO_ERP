import { Module } from '@nestjs/common';
import { XlsxController } from './xlsx.controller';
import { XlsxService } from './xlsx.service';
import { DocumentGridParserService } from './document-grid-parser.service';
import { GoodsModule } from '../goods/goods.module';
import { BrandsModule } from '../brands/brands.module';
import { UnitsModule } from '../units/units.module';
import { WorksModule } from '../works/works.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SettingsModule } from '../settings/settings.module';
import { ExchangeRatesModule } from '../exchange-rates/exchange-rates.module';
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
  ],
  controllers: [XlsxController],
  providers: [
    XlsxService,
    DocumentGridParserService,
    PurchaseOrderImportAdapter,
    StockDocumentImportAdapter,
    DocumentLineImportAdapterRegistry,
  ],
})
export class XlsxModule {}
