import { Module } from '@nestjs/common';
import { WarrantiesController } from './warranties.controller';
import { WarrantiesService } from './warranties.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [WarrantiesController],
  providers: [WarrantiesService],
  exports: [WarrantiesService],
})
export class WarrantiesModule {}
