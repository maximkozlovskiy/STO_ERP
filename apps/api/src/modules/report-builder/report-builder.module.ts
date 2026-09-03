import { Module } from '@nestjs/common';
import { ReportBuilderService } from './report-builder.service';
import { ReportBuilderController } from './report-builder.controller';

@Module({
  controllers: [ReportBuilderController],
  providers: [ReportBuilderService],
})
export class ReportBuilderModule {}
