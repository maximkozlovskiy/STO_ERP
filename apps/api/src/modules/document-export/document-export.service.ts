import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PDF_MIME, XLSX_MIME, DOCX_MIME } from '../../common/office/mime';
import { PdfService } from '../pdf/pdf.service';
import { OrgPrintInfoService } from '../pdf/org-print-info.service';
import type { OrgPrintInfo } from '../pdf/org-print-info.types';
import { renderDocumentXlsx } from './document-xlsx.renderer';
import { renderDocumentDocx } from './document-docx.renderer';
import { loadInvoicePrintable } from './invoice-printable';
import { loadPurchaseOrderPrintable } from './purchase-order-printable';
import { loadStockDocumentPrintable } from './stock-document-printable';
import { loadSupplierReturnPrintable } from './supplier-return-printable';
import type { ExportFormat, PrintableDocument } from './printable-document';

export type ExportableDocument = 'invoice' | 'purchaseOrder' | 'stockDocument' | 'supplierReturn';

const LOADERS: Record<
  ExportableDocument,
  (prisma: PrismaService, orgId: string, id: string) => Promise<PrintableDocument>
> = {
  invoice: loadInvoicePrintable,
  purchaseOrder: loadPurchaseOrderPrintable,
  stockDocument: loadStockDocumentPrintable,
  supplierReturn: loadSupplierReturnPrintable,
};

const MIME: Record<ExportFormat, string> = { pdf: PDF_MIME, xlsx: XLSX_MIME, docx: DOCX_MIME };

export interface ExportedFile {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

/** Блок організації як сторони документа: назва, ЄДРПОУ, адреса, телефон. */
function orgPartyLines(org: OrgPrintInfo): string[] {
  return [
    org.name,
    ...(org.edrpou ? [`ЄДРПОУ: ${org.edrpou}`] : []),
    ...(org.address ? [org.address] : []),
    ...(org.phone ? [`Тел.: ${org.phone}`] : []),
  ];
}

/**
 * «Друк» і «Зберегти як» документів (BR-INV-028, BR-PO-016, BR-SDOC-009, BR-SRET-014): мапер
 * документа → `PrintableDocument` → PDF / XLSX / DOCX. Документ і реквізити організації
 * читаються паралельно.
 */
@Injectable()
export class DocumentExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgPrintInfo: OrgPrintInfoService,
    private readonly pdf: PdfService,
  ) {}

  async export(
    kind: ExportableDocument,
    orgId: string,
    id: string,
    format: ExportFormat,
  ): Promise<ExportedFile> {
    const [loaded, org] = await Promise.all([
      LOADERS[kind](this.prisma, orgId, id),
      this.orgPrintInfo.get(orgId),
    ]);
    const doc: PrintableDocument = loaded.orgParty
      ? {
          ...loaded,
          parties: [{ label: loaded.orgParty, lines: orgPartyLines(org) }, ...loaded.parties],
        }
      : loaded;
    const buffer =
      format === 'pdf'
        ? await this.pdf.generateDocumentPdf(org, doc)
        : format === 'xlsx'
          ? await renderDocumentXlsx(org, doc)
          : renderDocumentDocx(org, doc);
    return { buffer, filename: `${doc.filenameBase}.${format}`, contentType: MIME[format] };
  }
}
