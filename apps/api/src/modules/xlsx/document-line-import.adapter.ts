import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { translateError, MAX_QUERY_LIMIT } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
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
  /**
   * ДОДАЄ рядки до наявних, не видаляючи їх. Тотали перераховуються по ОБ'ЄДНАНОМУ набору —
   * рахунок лише по нових рядках загубив би наявні позиції (фінансовий баг).
   * Колізія goodId з НАЯВНИМ рядком → кількість додається до нього (ціна береться нова, остання
   * накладна актуальніша), а не створюється другий рядок: PO/SD-line не мають @@unique(docId,goodId),
   * тож дубль тихо задвоїв би позицію (дух Bug #748, який покриває лише один імпорт).
   */
  appendLines(
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
      throw new ForbiddenException(translateError('err.xlsx.purchaseOrderNotDraft', getLocale()));
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

  async appendLines(
    tx: Prisma.TransactionClient,
    orgId: string,
    docId: string,
    lines: ImportLineInput[],
  ): Promise<void> {
    const { vatMode, vatRate } = await this.settings.getDefaultVatRate(orgId);

    // Наявні рядки: у них або доливаємо кількість (колізія goodId), або лишаємо як є.
    const existing = await tx.purchaseOrderLine.findMany({
      where: { purchaseOrderId: docId, orgId, deletedAt: null },
      select: { id: true, goodId: true, quantity: true, price: true },
      take: MAX_QUERY_LIMIT, // §3.2: OOM-guard, дзеркалить canonical purchase-orders.service
    });
    const byGoodId = new Map(existing.map(l => [l.goodId, l]));

    const toCreate: (ImportLineInput & { vatRate: number; vatAmount: number })[] = [];
    for (const l of lines) {
      const hit = byGoodId.get(l.goodId);
      if (hit) {
        // Доливаємо кількість до наявного рядка; ціна — нова (остання накладна актуальніша).
        const quantity = Number(hit.quantity) + l.quantity;
        const { vatAmount } = calcLineVat(l.price, quantity, vatRate, vatMode);
        await tx.purchaseOrderLine.updateMany({
          where: { id: hit.id, orgId },
          data: { quantity, price: l.price, vatRate, vatAmount },
        });
        // Наступний рядок файлу з тим самим товаром має долитись уже до оновленої кількості.
        byGoodId.set(l.goodId, { ...hit, quantity: quantity as never, price: l.price as never });
      } else {
        const { vatAmount } = calcLineVat(l.price, l.quantity, vatRate, vatMode);
        toCreate.push({ ...l, vatRate, vatAmount });
      }
    }

    if (toCreate.length) {
      await tx.purchaseOrderLine.createMany({
        data: toCreate.map(l => ({
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

    // Тотали — по ВСІХ активних рядках ПІСЛЯ вставки (не лише по нових), інакше наявні позиції
    // зникли б із суми документа.
    //
    // Рахуємо АГРЕГАЦІЄЮ в БД, а не findMany+reduce: сюди не можна ставити take-ліміт (на відміну
    // від запитів для відображення), бо зріз на MAX_QUERY_LIMIT=1000 тихо ЗАНИЗИВ би суму
    // документа — а один імпорт сам по собі допускає до 1000 рядків (ApplyImportDto.ArrayMaxSize),
    // тож «наявні + нові» легко перетинають межу. Агрегація не вивантажує рядки в пам'ять, тож
    // OOM-ризику теж немає. Canonical purchase-orders.service рахує тотали з масиву В ПАМ'ЯТІ
    // (рядки прийшли у запиті) — там take фізично не може зрізати суму, тут міг би.
    const agg = await tx.$queryRaw<{ total: number | null; vat: number | null }[]>`
      SELECT
        COALESCE(SUM("quantity" * "price"), 0)::float AS "total",
        COALESCE(SUM("vatAmount"), 0)::float          AS "vat"
      FROM purchase_order_lines
      WHERE "purchaseOrderId" = ${docId}::uuid
        AND "orgId"           = ${orgId}::uuid
        AND "deletedAt" IS NULL
    `;
    const totalAmount = roundMoney(Number(agg[0]?.total ?? 0));
    const totalVat = roundMoney(Number(agg[0]?.vat ?? 0));

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
      throw new ForbiddenException(translateError('err.xlsx.stockDocumentNotDraft', getLocale()));
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

  async appendLines(
    tx: Prisma.TransactionClient,
    orgId: string,
    docId: string,
    lines: ImportLineInput[],
  ): Promise<void> {
    // StockDocument тоталів не має — лише рядки. Колізія goodId з наявним рядком → доливаємо
    // кількість (ціна нова), інакше дубль тихо задвоїв би позицію на складі.
    const existing = await tx.stockDocumentLine.findMany({
      where: { stockDocumentId: docId, orgId, deletedAt: null },
      select: { id: true, goodId: true, quantity: true },
      take: MAX_QUERY_LIMIT, // §3.2: OOM-guard, дзеркалить canonical stock-documents.service
    });
    const byGoodId = new Map(existing.map(l => [l.goodId, l]));

    const toCreate: ImportLineInput[] = [];
    for (const l of lines) {
      const hit = byGoodId.get(l.goodId);
      if (hit) {
        const quantity = Number(hit.quantity) + l.quantity;
        await tx.stockDocumentLine.updateMany({
          where: { id: hit.id, orgId },
          data: { quantity, price: l.price },
        });
        byGoodId.set(l.goodId, { ...hit, quantity: quantity as never });
      } else {
        toCreate.push(l);
      }
    }

    if (toCreate.length) {
      await tx.stockDocumentLine.createMany({
        data: toCreate.map(l => ({
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
