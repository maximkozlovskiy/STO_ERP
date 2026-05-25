import { Module } from '@nestjs/common';
import { CompletionActsController } from './completion-acts.controller';
import { CompletionActsService } from './completion-acts.service';
import { DocumentNumberModule } from '../document-number/document-number.module';
import { InvoicesModule } from '../invoices/invoices.module';

@Module({
  imports: [DocumentNumberModule, InvoicesModule],
  controllers: [CompletionActsController],
  providers: [CompletionActsService],
  exports: [CompletionActsService],
})
export class CompletionActsModule {}
