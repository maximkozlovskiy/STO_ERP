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
import { AuditModule } from '../audit/audit.module';
import { DEFAULT_JOB_OPTS } from '../../common/scheduler/job-opts';

@Module({
  imports: [
    PdfModule,
    DocumentNumberModule,
    SettlementsModule,
    SettingsModule,
    AuditModule, // C1: аудит створення рахунку
    BullModule.registerQueue({ name: 'invoice-overdue', defaultJobOptions: DEFAULT_JOB_OPTS }),
  ],
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoiceOverdueScheduler, InvoiceOverdueProcessor],
  exports: [InvoicesService],
})
export class InvoicesModule {}
