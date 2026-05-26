import { Module } from '@nestjs/common';
import { WorkOrderTemplatesController } from './work-order-templates.controller';
import { WorkOrderTemplatesService } from './work-order-templates.service';

@Module({
  controllers: [WorkOrderTemplatesController],
  providers: [WorkOrderTemplatesService],
  exports: [WorkOrderTemplatesService],
})
export class WorkOrderTemplatesModule {}
