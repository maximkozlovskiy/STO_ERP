import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyService } from './loyalty.service';
import { LoyaltyProcessor } from './loyalty.processor';
import { PrismaModule } from '../../prisma/prisma.module';
import { DEFAULT_JOB_OPTS } from '../../common/scheduler/job-opts';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({ name: 'loyalty', defaultJobOptions: DEFAULT_JOB_OPTS }),
  ],
  controllers: [LoyaltyController],
  providers: [LoyaltyService, LoyaltyProcessor],
  exports: [LoyaltyService],
})
export class LoyaltyModule {}
