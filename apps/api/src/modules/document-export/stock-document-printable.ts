import { NotFoundException } from '@nestjs/common';
import type { StockDocumentType } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { err } from '../../common/utils/err';
import { LINE_ORDER_BY_CREATED } from '../../common/utils/line-order';
import { money, moneyFromDecimal, sumMoney } from '../../common/utils/money';
import {
  GOODS_COLUMNS,
  PRINT_LINE_GOOD_SELECT,
  fmtDateOnly,
  fmtKyivDate,
  lineUnit,
  printableFilenameBase,
  type PrintableDocument,
  type PrintableField,
} from './printable-document';

/** Назва документа за типом (BR-SDOC-009) і префікс імені файла. */
export const STOCK_DOCUMENT_PRINT_TITLES: Record<
  StockDocumentType,
  { title: string; file: string }
> = {
  WRITEOFF: { title: 'Списання', file: 'Списання' },
  TRANSFER: { title: 'Переміщення', file: 'Переміщення' },
  OPENING_BALANCE: { title: 'Введення залишків', file: 'Залишки' },
  RECEIPT: { title: 'Оприбуткування', file: 'Оприбуткування' },
};

/**
 * Складський документ для друку й «Зберегти як» (BR-SDOC-009). Сум у схемі немає: сума рядка =
 * `money(кількість × ціна)`, «Разом» — сума рядків із ціною; рядок без ціни — без ціни й суми;
 * жоден рядок без ціни — без «Разом».
 */
export async function loadStockDocumentPrintable(
  prisma: PrismaService,
  orgId: string,
  id: string,
): Promise<PrintableDocument> {
  const doc = await prisma.stockDocument.findFirst({
    where: { id, orgId },
    select: {
      number: true,
      type: true,
      documentDate: true,
      confirmedAt: true,
      notes: true,
      deletedAt: true,
      warehouse: { select: { name: true } },
      targetWarehouse: { select: { name: true } },
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
  if (!doc) throw new NotFoundException(err('err.stockDocument.notFound'));

  const rows = doc.lines.map(l => {
    const price = l.price == null ? null : moneyFromDecimal(l.price);
    return {
      cells: [l.good?.name ?? '—', l.quantity, lineUnit(l), price] as const,
      amount: price == null ? null : money(l.quantity * price),
    };
  });
  const priced = rows.map(r => r.amount).filter((a): a is NonNullable<typeof a> => a != null);
  const fields: PrintableField[] = [
    { label: 'Склад', value: doc.warehouse?.name ?? '—' },
    ...(doc.type === 'TRANSFER' && doc.targetWarehouse
      ? [{ label: 'Склад призначення', value: doc.targetWarehouse.name }]
      : []),
    ...(doc.purchaseOrder ? [{ label: 'Замовлення', value: doc.purchaseOrder.number }] : []),
    ...(doc.confirmedAt ? [{ label: 'Проведено', value: fmtKyivDate(doc.confirmedAt) }] : []),
  ];
  const names = STOCK_DOCUMENT_PRINT_TITLES[doc.type];
  return {
    title: names.title,
    number: doc.number,
    date: fmtDateOnly(doc.documentDate),
    deleted: doc.deletedAt != null,
    currencyCode: null,
    parties: [],
    fields,
    columns: [...GOODS_COLUMNS, { label: 'Сума', kind: 'money' }],
    rows: rows.map(r => [...r.cells, r.amount]),
    totals: priced.length > 0 ? [{ label: 'Разом', value: sumMoney(priced), strong: true }] : [],
    notes: doc.notes,
    filenameBase: printableFilenameBase(names.file, doc.number),
  };
}
