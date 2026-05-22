import { Module } from '@nestjs/common';
import { WorkCategoriesController } from './work-categories.controller';
import { WorkCategoriesService } from './work-categories.service';

@Module({
  controllers: [WorkCategoriesController],
  providers: [WorkCategoriesService],
  exports: [WorkCategoriesService],
})
export class WorkCategoriesModule {}
