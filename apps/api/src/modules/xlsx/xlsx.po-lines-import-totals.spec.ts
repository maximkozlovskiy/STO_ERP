/**
 * BR-PO-007 — швидкий імпорт рядків замовлення постачальнику з шаблону XLSX
 * (`POST /xlsx/import/purchase-order-lines/:id`, кнопка «Імпорт XLSX» у картці) після запису
 * рядків доводить документ до ладу: ПДВ рядків і тотали (`syncAfterDirectLineWrite` адаптера).
 *
 * Bug #843 (наживо 2026-10-13): імпорт змінив кількість і ціну рядка та додав новий, а
 * `totalAmount` замовлення лишився 103,00 при рядках на 118,00 — до першого «Зберегти» в картці,
 * якого після імпорту ніхто не вимагає. Від суми рахується залишок до сплати постачальнику.
 *
 * Сам перерахунок — `document-line-import.adapter.spec.ts`. Тут — що імпорт його кличе, і коли.
 *
 * Mutation-verify (2026-10-13): прибрати блок виклику з `importPOLines` → падають кейси 1–2;
 * прибрати умову `created > 0 || updated > 0` → падає кейс 3.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { XlsxService } from './xlsx.service';
import type { GoodMatcherService } from '../goods/good-matcher.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { DocumentLineImportAdapterRegistry } from './document-line-import.adapter';
import { DocumentGridParserService } from './document-grid-parser.service';
import { catalogMatcher, type CatalogGood } from './good-matcher.testing';

const ORG = '11111111-1111-4111-8111-111111111111';
const PO = '22222222-2222-4222-8222-222222222222';
const HEADER = ['Артикул (SKU)', 'Назва товару', 'К-ть', 'Ціна, ₴'];

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet');
  rows.forEach(r => sheet.addRow(r));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('XlsxService.importPOLines — ПДВ рядків і тотали після запису', () => {
  let matchMany: ReturnType<typeof vi.fn>;
  let sync: ReturnType<typeof vi.fn>;
  let order: string[];
  let prisma: {
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn> };
    purchaseOrderLine: {
      findMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let service: XlsxService;

  const seed = (goods: CatalogGood[]) => matchMany.mockImplementation(catalogMatcher(goods));

  beforeEach(() => {
    order = [];
    matchMany = vi.fn();
    sync = vi.fn().mockImplementation(() => {
      order.push('sync');
      return Promise.resolve();
    });
    prisma = {
      purchaseOrder: { findFirst: vi.fn().mockResolvedValue({ id: PO, status: 'DRAFT' }) },
      purchaseOrderLine: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockImplementation(() => {
          order.push('createMany');
          return Promise.resolve({ count: 1 });
        }),
        update: vi.fn().mockImplementation(() => {
          order.push('update');
          return Promise.resolve({});
        }),
      },
      $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };
    const unused = {} as never;
    service = new XlsxService(
      prisma as unknown as PrismaService,
      unused,
      unused,
      unused,
      {
        get: () => ({ syncAfterDirectLineWrite: sync }),
      } as unknown as DocumentLineImportAdapterRegistry,
      new DocumentGridParserService(),
      { get: vi.fn().mockResolvedValue(null), set: vi.fn() } as never,
      unused,
      { matchMany } as unknown as GoodMatcherService,
      null as never, // workOrderStock — імпорт товарів наряду (BR-WO-021) тут не задіяний
    );
  });

  // guards: BR-PO-007
  it('новий рядок записано → перерахунок один раз, ПІСЛЯ запису, у транзакції, для цього замовлення', async () => {
    seed([{ id: 'g1', name: 'Фільтр', sku: 'OC-90' }]);

    const res = await service.importPOLines(
      ORG,
      PO,
      await xlsx([HEADER, ['OC-90', 'Фільтр', 2, 100]]),
    );

    expect(res).toMatchObject({ created: 1, updated: 0, errors: [] });
    expect(order).toEqual(['createMany', 'sync']);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(prisma, ORG, PO);
  });

  // guards: BR-PO-007
  it('наявний рядок оновлено (кількість і ціна) → перерахунок теж іде', async () => {
    seed([{ id: 'g1', name: 'Фільтр', sku: 'OC-90' }]);
    prisma.purchaseOrderLine.findMany.mockResolvedValueOnce([{ id: 'line-1', goodId: 'g1' }]);

    const res = await service.importPOLines(
      ORG,
      PO,
      await xlsx([HEADER, ['OC-90', 'Фільтр', 11, 10]]),
    );

    expect(res).toMatchObject({ created: 0, updated: 1 });
    expect(order).toEqual(['update', 'sync']);
  });

  // guards: BR-PO-007
  it('жодного рядка не записано (товар не знайдено) → документ не чіпається', async () => {
    seed([]);

    const res = await service.importPOLines(
      ORG,
      PO,
      await xlsx([HEADER, ['НЕМА-1', 'Щось', 1, 5]]),
    );

    expect(res).toMatchObject({ created: 0, updated: 0 });
    expect(res.errors).toHaveLength(1);
    expect(sync).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
