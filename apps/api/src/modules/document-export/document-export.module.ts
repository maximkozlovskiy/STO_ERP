import { Module } from '@nestjs/common';
import { PdfModule } from '../pdf/pdf.module';
import { DocumentExportController } from './document-export.controller';
import { DocumentExportService } from './document-export.service';

@Module({
  imports: [PdfModule],
  controllers: [DocumentExportController],
  providers: [DocumentExportService],
})
export class DocumentExportModule {}
