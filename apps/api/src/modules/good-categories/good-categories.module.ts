import { Module } from '@nestjs/common';
import { GoodCategoriesController } from './good-categories.controller';
import { GoodCategoriesService } from './good-categories.service';

@Module({
  controllers: [GoodCategoriesController],
  providers: [GoodCategoriesService],
  exports: [GoodCategoriesService],
})
export class GoodCategoriesModule {}
