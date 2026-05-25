import { Module } from '@nestjs/common';
import { XlsxController } from './xlsx.controller';
import { XlsxService } from './xlsx.service';
import { GoodsModule } from '../goods/goods.module';
import { BrandsModule } from '../brands/brands.module';
import { UnitsModule } from '../units/units.module';
import { WorksModule } from '../works/works.module';

@Module({
  imports: [GoodsModule, BrandsModule, UnitsModule, WorksModule],
  controllers: [XlsxController],
  providers: [XlsxService],
})
export class XlsxModule {}
