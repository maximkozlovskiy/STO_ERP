import { Module, forwardRef } from '@nestjs/common';
import { GoodsController } from './goods.controller';
import { GoodsService } from './goods.service';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [forwardRef(() => InventoryModule)],
  controllers: [GoodsController],
  providers: [GoodsService],
  exports: [GoodsService],
})
export class GoodsModule {}
