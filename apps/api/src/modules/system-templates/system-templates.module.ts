import { Module } from '@nestjs/common';
import { SystemTemplatesController } from './system-templates.controller';
import { SystemTemplatesService } from './system-templates.service';

@Module({
  controllers: [SystemTemplatesController],
  providers: [SystemTemplatesService],
  exports: [SystemTemplatesService],
})
export class SystemTemplatesModule {}
