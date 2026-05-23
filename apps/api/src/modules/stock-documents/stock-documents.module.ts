import { Module } from '@nestjs/common';
import { StockDocumentsService } from './stock-documents.service';
import { StockDocumentsController } from './stock-documents.controller';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [InventoryModule],
  controllers: [StockDocumentsController],
  providers: [StockDocumentsService],
})
export class StockDocumentsModule {}
