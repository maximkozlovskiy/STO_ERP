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
  type PrintableColumn,
  type PrintableDocument,
  type PrintableField,
} from './printable-document';

/**
 * Замовлення постачальнику для друку й «Зберегти як» (BR-PO-016): постачальник, склад, договір,
 * дата оплати; рядки в порядку картки, сума рядка — `money(кількість × ціна)` (як `toDto`), ПДВ
 * рядка — збережений `vatAmount`; «ПДВ» і «Разом» — `totalVat` і `totalAmount`, як рядок «Разом»
 * у картці. Колонка ПДВ — лише коли в замовленні є ПДВ.
 */
export async function loadPurchaseOrderPrintable(
  prisma: PrismaService,
  orgId: string,
  id: string,
): Promise<PrintableDocument> {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id, orgId },
    select: {
      number: true,
      documentDate: true,
      paymentDate: true,
      notes: true,
      deletedAt: true,
      totalAmount: true,
      totalVat: true,
      currency: { select: { code: true } },
      supplier: { select: PRINT_PARTY_SELECT },
      warehouse: { select: { name: true } },
      contract: { select: { number: true } },
      lines: {
        where: { deletedAt: null },
        orderBy: LINE_ORDER_BY_CREATED,
        take: 1000,
        select: {
          quantity: true,
          price: true,
          vatAmount: true,
          ...PRINT_LINE_GOOD_SELECT,
        },
      },
    },
  });
  if (!po) throw new NotFoundException(err('err.purchaseOrder.notFound'));

  const totalVat = Number(po.totalVat ?? 0);
  const withVat = totalVat > 0 || po.lines.some(l => Number(l.vatAmount ?? 0) > 0);
  const columns: PrintableColumn[] = [
    ...GOODS_COLUMNS,
    ...(withVat ? [{ label: 'ПДВ', kind: 'money' as const }] : []),
    { label: 'Сума', kind: 'money' },
  ];
  const fields: PrintableField[] = [
    { label: 'Склад', value: po.warehouse?.name ?? '—' },
    ...(po.contract ? [{ label: 'Договір', value: po.contract.number }] : []),
    ...(po.paymentDate ? [{ label: 'Дата оплати', value: fmtDateOnly(po.paymentDate) }] : []),
  ];
  return {
    title: 'Замовлення постачальнику',
    number: po.number,
    date: fmtDateOnly(po.documentDate),
    deleted: po.deletedAt != null,
    currencyCode: po.currency?.code ?? null,
    parties: [counterpartyParty('Постачальник', po.supplier)],
    fields,
    columns,
    rows: po.lines.map(l => [
      l.good?.name ?? '—',
      l.quantity,
      lineUnit(l),
      Number(l.price),
      ...(withVat ? [Number(l.vatAmount ?? 0)] : []),
      money(l.quantity * moneyFromDecimal(l.price)),
    ]),
    totals: [
      ...(withVat ? [{ label: 'ПДВ', value: totalVat }] : []),
      { label: 'Разом', value: Number(po.totalAmount), strong: true },
    ],
    notes: po.notes,
    filenameBase: printableFilenameBase('Замовлення', po.number),
  };
}
