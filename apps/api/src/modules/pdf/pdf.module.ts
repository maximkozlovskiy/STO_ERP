import { Module } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { OrgPrintInfoService } from './org-print-info.service';
import { FilesModule } from '../files/files.module';

@Module({
  // FilesModule — логотип організації читається зі сховища для шапки документа.
  imports: [FilesModule],
  providers: [PdfService, OrgPrintInfoService],
  exports: [PdfService, OrgPrintInfoService],
})
export class PdfModule {}
