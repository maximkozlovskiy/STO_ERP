import { Module } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { InvoicesController } from './invoices.controller';
import { PdfModule } from '../pdf/pdf.module';
import { DocumentNumberModule } from '../document-number/document-number.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [PdfModule, DocumentNumberModule, SettlementsModule, SettingsModule],
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
