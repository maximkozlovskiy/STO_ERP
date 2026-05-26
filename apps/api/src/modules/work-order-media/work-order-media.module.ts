import { Module } from '@nestjs/common';
import { WorkOrderMediaController } from './work-order-media.controller';
import { WorkOrderMediaService } from './work-order-media.service';
import { FilesModule } from '../files/files.module';

@Module({
  imports: [FilesModule],
  controllers: [WorkOrderMediaController],
  providers: [WorkOrderMediaService],
  exports: [WorkOrderMediaService],
})
export class WorkOrderMediaModule {}
