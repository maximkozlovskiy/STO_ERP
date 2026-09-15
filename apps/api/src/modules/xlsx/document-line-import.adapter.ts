import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { roundMoney } from '../../common/utils/math';
import { calcLineVat } from '../../common/utils/vat';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';

export type ImportDocType = 'PURCHASE_ORDER' | 'STOCK_DOCUMENT';

/** Рядок для запису у документ (у ВАЛЮТІ документа — мультивалюта). */
export interface ImportLineInput {
  goodId: string;
  quantity: number;
  price: number;
}

/** Мінімальний зріз документа, потрібний майстру імпорту. */
export interface ImportDocSummary {
  id: string;
  status: string;
  currencyId?: string | null;
}

/**
 * Абстракція «документ, у який імпортуються рядки товарів». Дзеркалить line-replace патерн
 * канонічних сервісів (purchase-orders / stock-documents): soft-delete наявних рядків + createMany
 * нових. Кожен адаптер сам відповідає за перерахунок тоталів документа (PO рахує ПДВ + base-суму).
 */
export interface DocumentLineImportAdapter {
  readonly docType: ImportDocType;
  loadDoc(orgId: string, docId: string): Promise<ImportDocSummary | null>;
  /** Кидає ForbiddenException якщо документ не у статусі DRAFT. */
  assertDraft(status: string): void;
  /** Замінює ВСІ рядки документа на передані (у $transaction tx). createdBy — для audit-полів. */
  replaceLines(
    tx: Prisma.TransactionClient,
    orgId: string,
    docId: string,
    lines: ImportLineInput[],
    createdBy?: string,
  ): Promise<void>;
}

// ─── Purchase Order ────────────────────────────────────────────────────────────

@Injectable()
export class PurchaseOrderImportAdapter implements DocumentLineImportAdapter {
  readonly docType: ImportDocType = 'PURCHASE_ORDER';

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly exchangeRates: ExchangeRatesService,
  ) {}

  async loadDoc(orgId: string, docId: string): Promise<ImportDocSummary | null> {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: docId, orgId, deletedAt: null },
      select: { id: true, status: true, currencyId: true, documentDate: true },
    });
    return po ? { id: po.id, status: po.status, currencyId: po.currencyId } : null;
  }

  assertDraft(status: string): void {
    if (status !== 'DRAFT') {
      throw new ForbiddenException('Замовлення постачальника не в статусі DRAFT');
    }
  }

  async replaceLines(
    tx: Prisma.TransactionClient,
    orgId: string,
    docId: string,
    lines: ImportLineInput[],
  ): Promise<void> {
    // ПДВ рахуємо за default-режимом org (як у purchase-orders.create). Ціни рядків — у валюті PO.
    const { vatMode, vatRate } = await this.settings.getDefaultVatRate(orgId);
    const computed = lines.map(l => {
      const { vatAmount } = calcLineVat(l.price, l.quantity, vatRate, vatMode);
      return { ...l, vatRate, vatAmount };
    });
    const totalAmount = roundMoney(computed.reduce((s, l) => s + l.quantity * l.price, 0));
    const totalVat = roundMoney(computed.reduce((s, l) => s + l.vatAmount, 0));

    // База по курсу на дату документа (як у purchase-orders). currencyId NOT NULL (TD1), але
    // читаємо актуальний документ у tenant-scope, щоб не довіряти стороннім значенням.
    const po = await tx.purchaseOrder.findFirstOrThrow({
      where: { id: docId, orgId, deletedAt: null },
      select: { currencyId: true, documentDate: true },
    });
    const conv = await this.exchangeRates.resolveBaseConversion(
      orgId,
      po.currencyId,
      po.documentDate ?? new Date(),
      totalAmount,
      true,
    );

    // Line-replace: soft-delete наявних + createMany нових (той самий патерн, що PO.update).
    await tx.purchaseOrderLine.updateMany({
      where: { purchaseOrderId: docId, orgId },
      data: { deletedAt: new Date() },
    });
    if (computed.length) {
      await tx.purchaseOrderLine.createMany({
        data: computed.map(l => ({
          orgId,
          purchaseOrderId: docId,
          goodId: l.goodId,
          quantity: l.quantity,
          price: l.price,
          vatRate: l.vatRate,
          vatAmount: l.vatAmount,
        })),
      });
    }
    await tx.purchaseOrder.updateMany({
      where: { id: docId, orgId, deletedAt: null },
      data: {
        totalAmount,
        totalVat,
        totalAmountBase: conv.amountBase,
        rateUsed: conv.rateUsed,
      },
    });
  }
}

// ─── Stock Document (RECEIPT та ін.) ─────────────────────────────────────────────

@Injectable()
export class StockDocumentImportAdapter implements DocumentLineImportAdapter {
  readonly docType: ImportDocType = 'STOCK_DOCUMENT';

  constructor(private readonly prisma: PrismaService) {}

  async loadDoc(orgId: string, docId: string): Promise<ImportDocSummary | null> {
    const doc = await this.prisma.stockDocument.findFirst({
      where: { id: docId, orgId, deletedAt: null },
      select: { id: true, status: true },
    });
    return doc ? { id: doc.id, status: doc.status, currencyId: null } : null;
  }

  assertDraft(status: string): void {
    if (status !== 'DRAFT') {
      throw new ForbiddenException('Складський документ не в статусі DRAFT');
    }
  }

  async replaceLines(
    tx: Prisma.TransactionClient,
    orgId: string,
    docId: string,
    lines: ImportLineInput[],
  ): Promise<void> {
    // StockDocumentLine.price nullable — але майстер завжди дає ціну (валюта документа/базова).
    await tx.stockDocumentLine.updateMany({
      where: { stockDocumentId: docId, orgId },
      data: { deletedAt: new Date() },
    });
    if (lines.length) {
      await tx.stockDocumentLine.createMany({
        data: lines.map(l => ({
          orgId,
          stockDocumentId: docId,
          goodId: l.goodId,
          quantity: l.quantity,
          price: l.price,
        })),
      });
    }
  }
}

// ─── Registry ────────────────────────────────────────────────────────────────

/** Реєстр адаптерів імпорту рядків per-docType. Розширення — новий адаптер + гілка тут. */
@Injectable()
export class DocumentLineImportAdapterRegistry {
  private readonly registry: Record<ImportDocType, DocumentLineImportAdapter>;

  constructor(poAdapter: PurchaseOrderImportAdapter, sdAdapter: StockDocumentImportAdapter) {
    this.registry = {
      PURCHASE_ORDER: poAdapter,
      STOCK_DOCUMENT: sdAdapter,
    };
  }

  get(docType: ImportDocType): DocumentLineImportAdapter {
    return this.registry[docType];
  }
}
