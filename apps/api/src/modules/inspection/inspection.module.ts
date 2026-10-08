import { Module } from '@nestjs/common';
import { InspectionController } from './inspection.controller';
import { InspectionService } from './inspection.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { WorkOrderTotalsModule } from '../work-orders/work-order-totals.module';

@Module({
  imports: [PrismaModule, WorkOrderTotalsModule],
  controllers: [InspectionController],
  providers: [InspectionService],
  exports: [InspectionService],
})
export class InspectionModule {}
