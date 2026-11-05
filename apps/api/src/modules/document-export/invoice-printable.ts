import { NotFoundException } from '@nestjs/common';
import { WORK_UNIT_SHORT_NAME } from '@sto/shared';
import type { PrismaService } from '../../prisma/prisma.service';
import { err } from '../../common/utils/err';
import { INVOICE_LINE_ORDER } from '../invoices/invoices.service';
import {
  GOODS_COLUMNS,
  PRINT_LINE_GOOD_SELECT,
  PRINT_PARTY_SELECT,
  counterpartyParty,
  fmtDateOnly,
  fmtKyivDate,
  lineUnit,
  printableFilenameBase,
  type PrintableDocument,
} from './printable-document';

/**
 * Рахунок для друку й «Зберегти як» (BR-INV-028). Рядки — у порядку картки
 * (`INVOICE_LINE_ORDER`), одиниця рядка — як у картці (BR-INV-021: одиниця рядка → базова
 * одиниця товару; робота — «год»), підсумки — ті самі колонки, що `GET /invoices/:id/pdf`.
 * Видалений рахунок знаходиться (позначка «ВИДАЛЕНО»), чужий — 404.
 */
export async function loadInvoicePrintable(
  prisma: PrismaService,
  orgId: string,
  id: string,
): Promise<PrintableDocument> {
  const inv = await prisma.invoice.findFirst({
    where: { id, orgId },
    select: {
      number: true,
      documentDate: true,
      dueDate: true,
      notes: true,
      deletedAt: true,
      totalWithoutVat: true,
      totalVat: true,
      totalWithVat: true,
      currency: { select: { code: true } },
      counterparty: { select: PRINT_PARTY_SELECT },
      lines: {
        orderBy: INVOICE_LINE_ORDER,
        take: 500,
        select: {
          description: true,
          quantity: true,
          unitPrice: true,
          vatRate: true,
          priceWithVat: true,
          workId: true,
          ...PRINT_LINE_GOOD_SELECT,
        },
      },
    },
  });
  if (!inv) throw new NotFoundException(err('err.invoice.notFound'));

  return {
    title: 'Рахунок',
    number: inv.number,
    date: fmtDateOnly(inv.documentDate),
    deleted: inv.deletedAt != null,
    currencyCode: inv.currency?.code ?? null,
    orgParty: 'Постачальник',
    parties: [counterpartyParty('Платник', inv.counterparty)],
    fields: inv.dueDate ? [{ label: 'Оплатити до', value: fmtKyivDate(inv.dueDate) }] : [],
    columns: [...GOODS_COLUMNS, { label: 'ПДВ, %', kind: 'qty' }, { label: 'Сума', kind: 'money' }],
    rows: inv.lines.map(l => [
      l.description,
      l.quantity,
      lineUnit(l, l.workId ? WORK_UNIT_SHORT_NAME : 'шт'),
      Number(l.unitPrice),
      Number(l.vatRate),
      Number(l.priceWithVat),
    ]),
    totals: [
      { label: 'Разом', value: Number(inv.totalWithoutVat) },
      { label: 'ПДВ', value: Number(inv.totalVat) },
      { label: 'До сплати', value: Number(inv.totalWithVat), strong: true },
    ],
    notes: inv.notes,
    filenameBase: printableFilenameBase('Рахунок', inv.number),
  };
}
