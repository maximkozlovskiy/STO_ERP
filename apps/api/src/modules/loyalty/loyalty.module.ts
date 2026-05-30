import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyService } from './loyalty.service';
import { LoyaltyProcessor } from './loyalty.processor';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule, BullModule.registerQueue({ name: 'loyalty' })],
  controllers: [LoyaltyController],
  providers: [LoyaltyService, LoyaltyProcessor],
  exports: [LoyaltyService],
})
export class LoyaltyModule {}
