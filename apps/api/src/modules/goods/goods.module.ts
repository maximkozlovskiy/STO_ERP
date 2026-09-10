import { Module, forwardRef } from '@nestjs/common';
import { GoodsController } from './goods.controller';
import { GoodsService } from './goods.service';
import { InventoryModule } from '../inventory/inventory.module';
import { GoodStatusesModule } from '../good-statuses/good-statuses.module';

@Module({
  imports: [forwardRef(() => InventoryModule), GoodStatusesModule],
  controllers: [GoodsController],
  providers: [GoodsService],
  exports: [GoodsService],
})
export class GoodsModule {}
