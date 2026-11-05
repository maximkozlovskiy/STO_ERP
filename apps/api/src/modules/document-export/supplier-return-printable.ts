import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import { err } from '../../common/utils/err';
import { LINE_ORDER_BY_CREATED } from '../../common/utils/line-order';
import { money, moneyFromDecimal } from '../../common/utils/money';
import {
  GOODS_COLUMNS,
  PRINT_LINE_GOOD_SELECT,
  PRINT_PARTY_SELECT,
  counterpartyParty,
  fmtDateOnly,
  lineUnit,
  printableFilenameBase,
  type PrintableDocument,
} from './printable-document';

/**
 * Повернення постачальнику для друку й «Зберегти як» (BR-SRET-014): постачальник, склад,
 * замовлення-джерело; рядки в порядку картки (BR-PO-008), сума рядка — `money(кількість × ціна)`;
 * «Разом» — `totalAmount` (ПДВ у поверненні немає, валюта — гривня).
 */
export async function loadSupplierReturnPrintable(
  prisma: PrismaService,
  orgId: string,
  id: string,
): Promise<PrintableDocument> {
  const sr = await prisma.supplierReturn.findFirst({
    where: { id, orgId },
    select: {
      number: true,
      documentDate: true,
      notes: true,
      deletedAt: true,
      totalAmount: true,
      supplier: { select: PRINT_PARTY_SELECT },
      warehouse: { select: { name: true } },
      purchaseOrder: { select: { number: true } },
      lines: {
        where: { deletedAt: null },
        orderBy: LINE_ORDER_BY_CREATED,
        take: 1000,
        select: {
          quantity: true,
          price: true,
          ...PRINT_LINE_GOOD_SELECT,
        },
      },
    },
  });
  if (!sr) throw new NotFoundException(err('err.supplierReturn.notFound'));

  return {
    title: 'Повернення постачальнику',
    number: sr.number,
    date: fmtDateOnly(sr.documentDate),
    deleted: sr.deletedAt != null,
    currencyCode: null,
    parties: [counterpartyParty('Постачальник', sr.supplier)],
    fields: [
      { label: 'Склад', value: sr.warehouse?.name ?? '—' },
      ...(sr.purchaseOrder ? [{ label: 'Замовлення', value: sr.purchaseOrder.number }] : []),
    ],
    columns: [...GOODS_COLUMNS, { label: 'Сума', kind: 'money' }],
    rows: sr.lines.map(l => [
      l.good?.name ?? '—',
      l.quantity,
      lineUnit(l),
      Number(l.price),
      money(l.quantity * moneyFromDecimal(l.price)),
    ]),
    totals: [{ label: 'Разом', value: Number(sr.totalAmount), strong: true }],
    notes: sr.notes,
    filenameBase: printableFilenameBase('Повернення', sr.number),
  };
}
