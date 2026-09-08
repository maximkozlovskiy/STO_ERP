import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { InvoicesService } from './invoices.service';
import { InvoicesController } from './invoices.controller';
import { InvoiceOverdueScheduler } from './invoice-overdue.scheduler';
import { InvoiceOverdueProcessor } from './invoice-overdue.processor';
import { PdfModule } from '../pdf/pdf.module';
import { DocumentNumberModule } from '../document-number/document-number.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    PdfModule,
    DocumentNumberModule,
    SettlementsModule,
    SettingsModule,
    BullModule.registerQueue({ name: 'invoice-overdue' }),
  ],
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoiceOverdueScheduler, InvoiceOverdueProcessor],
  exports: [InvoicesService],
})
export class InvoicesModule {}
