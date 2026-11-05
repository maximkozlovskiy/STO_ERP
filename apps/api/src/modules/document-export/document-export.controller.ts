import { Controller, Get, Param, ParseUUIDPipe, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { sendFile } from '../../common/http/send-file';
import { DOCX_MIME, PDF_MIME, XLSX_MIME } from '../../common/office/mime';
import { DocumentExportService, type ExportableDocument } from './document-export.service';
import { EXPORT_FORMATS, parseExportFormat } from './printable-document';

const FORMAT_PARAM = {
  name: 'format',
  enum: EXPORT_FORMATS,
  description: 'Формат файла; інший — 400',
} as const;
const FILE_RESPONSE = {
  description: "Файл документа; ім'я — у Content-Disposition (filename*=UTF-8''…)",
  schema: { type: 'string', format: 'binary' },
} as const;

/**
 * Друк і «Зберегти як» документів: `GET /<документ>/:id/export/:format`. Ролі кожного маршруту —
 * ті самі, що читають документ (`GET /<документ>/:id`). Видалений документ друкується з позначкою
 * «ВИДАЛЕНО», чужий чи неіснуючий — 404.
 */
@ApiTags('Document export')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class DocumentExportController {
  constructor(private readonly service: DocumentExportService) {}

  @Get('invoices/:id/export/:format')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Рахунок у PDF / Excel / Word (BR-INV-028)' })
  @ApiParam(FORMAT_PARAM)
  @ApiProduces(PDF_MIME, XLSX_MIME, DOCX_MIME)
  @ApiOkResponse(FILE_RESPONSE)
  invoice(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('format') format: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.send(reply, 'invoice', orgId, id, format);
  }

  @Get('purchase-orders/:id/export/:format')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Замовлення постачальнику у PDF / Excel / Word (BR-PO-016)' })
  @ApiParam(FORMAT_PARAM)
  @ApiProduces(PDF_MIME, XLSX_MIME, DOCX_MIME)
  @ApiOkResponse(FILE_RESPONSE)
  purchaseOrder(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('format') format: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.send(reply, 'purchaseOrder', orgId, id, format);
  }

  @Get('stock-documents/:id/export/:format')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Складський документ у PDF / Excel / Word (BR-SDOC-009)' })
  @ApiParam(FORMAT_PARAM)
  @ApiProduces(PDF_MIME, XLSX_MIME, DOCX_MIME)
  @ApiOkResponse(FILE_RESPONSE)
  stockDocument(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('format') format: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.send(reply, 'stockDocument', orgId, id, format);
  }

  @Get('supplier-returns/:id/export/:format')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Повернення постачальнику у PDF / Excel / Word (BR-SRET-014)' })
  @ApiParam(FORMAT_PARAM)
  @ApiProduces(PDF_MIME, XLSX_MIME, DOCX_MIME)
  @ApiOkResponse(FILE_RESPONSE)
  supplierReturn(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('format') format: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.send(reply, 'supplierReturn', orgId, id, format);
  }

  /** Формат перевіряється до читання документа: невідомий — 400 без запиту в базу. */
  private async send(
    reply: FastifyReply,
    kind: ExportableDocument,
    orgId: string,
    id: string,
    rawFormat: string,
  ): Promise<void> {
    const format = parseExportFormat(rawFormat);
    const file = await this.service.export(kind, orgId, id, format);
    sendFile(reply, file.buffer, file.filename, file.contentType);
  }
}
