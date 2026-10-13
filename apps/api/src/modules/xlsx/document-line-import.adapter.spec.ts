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
    $queryRaw: ReturnType<typeof vi.fn>;
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
      // Тотали рахуються АГРЕГАЦІЄЮ в БД (а не findMany+reduce): take-ліміт тут тихо занизив би
      // суму документа, бо один імпорт сам допускає до 1000 рядків.
      $queryRaw: vi.fn().mockResolvedValue([{ total: 0, vat: 0 }]),
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
    tx.purchaseOrderLine.findMany.mockResolvedValueOnce([]); // наявні (для merge-мапи)
    // Агрегація по БД повертає суму по ВСЬОМУ документу: наявна позиція 2×100 + нова 1×50.
    tx.$queryRaw.mockResolvedValueOnce([{ total: 250, vat: 0 }]);

    await adapter.appendLines(tx as never, ORG, DOC, lines(['g-2', 1, 50]));

    const upd = tx.purchaseOrder.updateMany.mock.calls[0]?.[0] as {
      data: { totalAmount: number };
    };
    expect(upd.data.totalAmount).toBe(250); // наявна позиція НЕ загубилась
  });

  it('тотали беруться з агрегації БД (без take-ліміту), а не з findMany рядків', async () => {
    // Регресія: take: MAX_QUERY_LIMIT на запиті-перерахунку тихо занизив би суму документа,
    // якщо позицій більше за ліміт (один імпорт сам допускає до 1000 рядків).
    tx.purchaseOrderLine.findMany.mockResolvedValueOnce([]);
    tx.$queryRaw.mockResolvedValueOnce([{ total: 999999.5, vat: 12.34 }]);

    await adapter.appendLines(tx as never, ORG, DOC, lines(['g-9', 1, 1]));

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const upd = tx.purchaseOrder.updateMany.mock.calls[0]?.[0] as {
      data: { totalAmount: number; totalVat: number };
    };
    expect(upd.data.totalAmount).toBe(999999.5);
    expect(upd.data.totalVat).toBe(12.34);
  });

  it('порожній список рядків не ламає перерахунок', async () => {
    await expect(adapter.appendLines(tx as never, ORG, DOC, [])).resolves.toBeUndefined();
    expect(tx.purchaseOrder.updateMany).toHaveBeenCalledTimes(1);
  });
});

/**
 * BR-PO-007 — після швидкого імпорту («Імпорт XLSX» у картці замовлення) рядки записано напряму:
 * ПДВ рядка і сума документа лишались такими, як до імпорту (Bug #843, наживо 2026-10-13: у базі
 * totalAmount 103,00 при рядках на 118,00; у зміненого рядка ПДВ від старої кількості).
 *
 * Mutation-verify (2026-10-13): прибрати оновлення ПДВ рядка → падає кейс 1; прибрати виклик
 * recalcTotals → падає кейс 2; прибрати курсор → падає кейс 3.
 */
describe('PurchaseOrderImportAdapter.syncAfterDirectLineWrite', () => {
  let tx: {
    purchaseOrderLine: {
      findMany: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    purchaseOrder: {
      findFirstOrThrow: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  let adapter: PurchaseOrderImportAdapter;

  beforeEach(() => {
    tx = {
      purchaseOrderLine: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      purchaseOrder: {
        findFirstOrThrow: vi
          .fn()
          .mockResolvedValue({ currencyId: 'cur-1', documentDate: new Date('2026-01-15') }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ total: 0, vat: 0 }]),
    };
    adapter = new PurchaseOrderImportAdapter(
      {} as PrismaService,
      {
        getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'EXCLUSIVE', vatRate: 20 }),
      } as unknown as SettingsService,
      {
        resolveBaseConversion: vi.fn().mockResolvedValue({ amountBase: 4720, rateUsed: 40 }),
      } as unknown as ExchangeRatesService,
    );
  });

  // guards: BR-PO-007
  it('ПДВ рядка перераховується від чинних кількості й ціни; рядок із правильним ПДВ не чіпається', async () => {
    tx.purchaseOrderLine.findMany.mockResolvedValueOnce([
      // імпорт змінив 5 × 20 на 11 × 10, ПДВ лишився від старих значень
      { id: 'l-stale', quantity: 11, price: 10, vatRate: 20, vatAmount: 20 },
      // новий рядок імпорту — без ПДВ узагалі
      { id: 'l-new', quantity: 0.5, price: 10, vatRate: 0, vatAmount: 0 },
      // рядок, якого імпорт не торкався: 2 × 100, ПДВ 40 — правильний
      { id: 'l-ok', quantity: 2, price: 100, vatRate: 20, vatAmount: 40 },
    ]);

    await adapter.syncAfterDirectLineWrite(tx as never, ORG, DOC);

    const updates = tx.purchaseOrderLine.updateMany.mock.calls.map(c => {
      const arg = c[0] as { where: { id: string }; data: { vatRate: number; vatAmount: unknown } };
      return [arg.where.id, arg.data.vatRate, Number(arg.data.vatAmount)];
    });
    expect(updates).toEqual([
      ['l-stale', 20, 22],
      ['l-new', 20, 1],
    ]);
  });

  // guards: BR-PO-007
  it('тотали замовлення пишуться з агрегації по всіх активних рядках, з сумою в базовій валюті', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ total: 118, vat: 23.6 }]);

    await adapter.syncAfterDirectLineWrite(tx as never, ORG, DOC);

    expect(tx.purchaseOrder.updateMany).toHaveBeenCalledTimes(1);
    const upd = tx.purchaseOrder.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(upd.where).toEqual({ id: DOC, orgId: ORG, deletedAt: null });
    expect(Number(upd.data.totalAmount)).toBe(118);
    expect(Number(upd.data.totalVat)).toBe(23.6);
    expect(upd.data).toMatchObject({ totalAmountBase: 4720, rateUsed: 40 });
  });

  // guards: BR-PO-007
  it('рядків більше за пачку → читає далі за курсором, а не зрізає на першій пачці', async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      id: `l-${String(i).padStart(3, '0')}`,
      quantity: 1,
      price: 10,
      vatRate: 20,
      vatAmount: 2,
    }));
    tx.purchaseOrderLine.findMany
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([{ id: 'l-last', quantity: 3, price: 10, vatRate: 0, vatAmount: 0 }]);

    await adapter.syncAfterDirectLineWrite(tx as never, ORG, DOC);

    expect(tx.purchaseOrderLine.findMany).toHaveBeenCalledTimes(2);
    expect(tx.purchaseOrderLine.findMany.mock.calls[1]![0]).toMatchObject({
      cursor: { id: 'l-499' },
      skip: 1,
      where: { purchaseOrderId: DOC, orgId: ORG, deletedAt: null },
    });
    expect(tx.purchaseOrderLine.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.purchaseOrderLine.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: 'l-last', orgId: ORG },
    });
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
