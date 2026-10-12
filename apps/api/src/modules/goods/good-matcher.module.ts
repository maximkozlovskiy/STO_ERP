import { Module } from '@nestjs/common';
import { BrandsModule } from '../brands/brands.module';
import { GoodMatcherService } from './good-matcher.service';

/**
 * Окремий від GoodsModule: пошук товару потрібен і XlsxModule, і InventoryModule (правила
 * ціноутворення), а GoodsModule уже стоїть із InventoryModule у forwardRef-циклі.
 */
@Module({
  imports: [BrandsModule],
  providers: [GoodMatcherService],
  exports: [GoodMatcherService],
})
export class GoodMatcherModule {}
