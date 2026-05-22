import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { DocumentNumberingService } from './document-numbering.service';

@Module({
  controllers: [SettingsController],
  providers: [SettingsService, DocumentNumberingService],
  exports: [SettingsService, DocumentNumberingService],
})
export class SettingsModule {}
