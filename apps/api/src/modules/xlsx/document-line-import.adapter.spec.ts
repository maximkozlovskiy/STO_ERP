import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PurchaseOrderImportAdapter,
  StockDocumentImportAdapter,
  type ImportLineInput,
} from './document-line-import.adapter';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SettingsService } from '../settings/settings.service';
import type { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';

/**
 * Тести appendLines — найризикованішої частини режиму «додати»: тотали мусять рахуватись по
 * ОБ'ЄДНАНОМУ набору (інакше наявні позиції зникають із суми документа = фінансовий баг), а
 * дублікат goodId з наявним рядком мусить доливати кількість (PO/SD-line не мають
 * @@unique(docId, goodId), тож другий рядок тихо задвоїв би позицію).
 */

const ORG = 'org-1';
const DOC = 'doc-1';

describe('PurchaseOrderImportAdapter.appendLines', () => {
  let tx: {
    purchaseOrderLine: {
      findMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    purchaseOrder: {
      findFirstOrThrow: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  };
  let adapter: PurchaseOrderImportAdapter;

  beforeEach(() => {
    tx = {
      purchaseOrderLine: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      purchaseOrder: {
        findFirstOrThrow: vi
          .fn()
          .mockResolvedValue({ currencyId: 'cur-1', documentDate: new Date('2026-01-15') }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    adapter = new PurchaseOrderImportAdapter(
      {} as PrismaService,
      {
        getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }),
      } as unknown as SettingsService,
      {
        resolveBaseConversion: vi.fn().mockResolvedValue({ amountBase: 0, rateUsed: 1 }),
      } as unknown as ExchangeRatesService,
    );
  });

  const lines = (...l: [string, number, number][]): ImportLineInput[] =>
    l.map(([goodId, quantity, price]) => ({ goodId, quantity, price }));

  it('НЕ видаляє наявні рядки (на відміну від replaceLines)', async () => {
    await adapter.appendLines(tx as never, ORG, DOC, lines(['g-1', 2, 100]));
    // updateMany на рядках викликається лише для merge-колізій, не для soft-delete
    const softDeleteCalls = tx.purchaseOrderLine.updateMany.mock.calls.filter(
      c => (c[0] as { data?: { deletedAt?: unknown } })?.data?.deletedAt !== undefined,
    );
    expect(softDeleteCalls).toHaveLength(0);
  });

  it('новий goodId → createMany', async () => {
    tx.purchaseOrderLine.findMany.mockResolvedValueOnce([]); // наявних немає
    await adapter.appendLines(tx as never, ORG, DOC, lines(['g-1', 2, 100]));
    expect(tx.purchaseOrderLine.createMany).toHaveBeenCalledTimes(1);
    const data = (tx.purchaseOrderLine.createMany.mock.calls[0]?.[0] as { data: unknown[] }).data;
    expect(data).toHaveLength(1);
  });

  it('дублікат goodId з НАЯВНИМ рядком → доливає кількість, НЕ створює другий рядок', async () => {
    tx.purchaseOrderLine.findMany.mockResolvedValueOnce([
      { id: 'line-1', goodId: 'g-1', quantity: 5, price: 90 },
    ]);
    await adapter.appendLines(tx as never, ORG, DOC, lines(['g-1', 3, 110]));

    // createMany або не викликався, або з порожнім набором
    const created = tx.purchaseOrderLine.createMany.mock.calls[0]?.[0] as
      { data: unknown[] } | undefined;
    expect(created?.data ?? []).toHaveLength(0);

    const merge = tx.purchaseOrderLine.updateMany.mock.calls.find(
      c => (c[0] as { where?: { id?: string } })?.where?.id === 'line-1',
    );
    expect(merge).toBeDefined();
    const data = (merge?.[0] as { data: { quantity: number; price: number } }).data;
    expect(data.quantity).toBe(8); // 5 наявних + 3 нових
    expect(data.price).toBe(110); // ціна НОВА — остання накладна актуальніша
  });

  it('два рядки файлу з тим самим goodId доливаються послідовно (5→8→10)', async () => {
    tx.purchaseOrderLine.findMany.mockResolvedValueOnce([
      { id: 'line-1', goodId: 'g-1', quantity: 5, price: 90 },
    ]);
    await adapter.appendLines(tx as never, ORG, DOC, lines(['g-1', 3, 100], ['g-1', 2, 120]));

    const merges = tx.purchaseOrderLine.updateMany.mock.calls.filter(
      c => (c[0] as { where?: { id?: string } })?.where?.id === 'line-1',
    );
    expect(merges).toHaveLength(2);
    const last = (merges[1]?.[0] as { data: { quantity: number } }).data;
    expect(last.quantity).toBe(10); // 5 + 3 + 2
  });

  it('тотали рахуються по ВСІХ активних рядках ПІСЛЯ вставки, не лише по нових', async () => {
    tx.purchaseOrderLine.findMany
      .mockResolvedValueOnce([]) // крок 1: наявні (для merge-мапи)
      .mockResolvedValueOnce([
        // крок 2: усі активні ПІСЛЯ вставки — тут і наявна позиція, і нова
        { quantity: 2, price: 100, vatAmount: 0 },
        { quantity: 1, price: 50, vatAmount: 0 },
      ]);

    await adapter.appendLines(tx as never, ORG, DOC, lines(['g-2', 1, 50]));

    const upd = tx.purchaseOrder.updateMany.mock.calls[0]?.[0] as {
      data: { totalAmount: number };
    };
    expect(upd.data.totalAmount).toBe(250); // 2×100 + 1×50 — наявна позиція НЕ загубилась
  });

  it('порожній список рядків не ламає перерахунок', async () => {
    await expect(adapter.appendLines(tx as never, ORG, DOC, [])).resolves.toBeUndefined();
    expect(tx.purchaseOrder.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('StockDocumentImportAdapter.appendLines', () => {
  let tx: {
    stockDocumentLine: {
      findMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  };
  let adapter: StockDocumentImportAdapter;

  beforeEach(() => {
    tx = {
      stockDocumentLine: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    adapter = new StockDocumentImportAdapter({} as PrismaService);
  });

  it('новий goodId → createMany, наявні не чіпаються', async () => {
    await adapter.appendLines(tx as never, ORG, DOC, [{ goodId: 'g-1', quantity: 2, price: 10 }]);
    expect(tx.stockDocumentLine.createMany).toHaveBeenCalledTimes(1);
    const softDelete = tx.stockDocumentLine.updateMany.mock.calls.filter(
      c => (c[0] as { data?: { deletedAt?: unknown } })?.data?.deletedAt !== undefined,
    );
    expect(softDelete).toHaveLength(0);
  });

  it('дублікат goodId → доливає кількість (склад не задвоюється)', async () => {
    tx.stockDocumentLine.findMany.mockResolvedValueOnce([
      { id: 'sl-1', goodId: 'g-1', quantity: 4 },
    ]);
    await adapter.appendLines(tx as never, ORG, DOC, [{ goodId: 'g-1', quantity: 6, price: 15 }]);

    const merge = tx.stockDocumentLine.updateMany.mock.calls.find(
      c => (c[0] as { where?: { id?: string } })?.where?.id === 'sl-1',
    );
    const data = (merge?.[0] as { data: { quantity: number; price: number } }).data;
    expect(data.quantity).toBe(10);
    expect(data.price).toBe(15);
  });
});
