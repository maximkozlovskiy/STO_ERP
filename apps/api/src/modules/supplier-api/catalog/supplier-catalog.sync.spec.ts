import type { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../prisma/prisma.service';
import { memoryTable } from '../../cash/cash.spec-fixture';
import { SupplierAdapterRegistry } from '../adapters/supplier-adapter-registry';
import type { CatalogMirrorRow, SupplierAdapter } from '../adapters/supplier-adapter.interface';
import { CONN, connectionCtx, ORG } from '../supplier-api.spec-fixture';
import { SupplierCatalogService } from './supplier-catalog.service';

/**
 * Дзеркало каталогу AVD (BR-SCON-015): масовий upsert сирим SQL і зняття не побачених рядків.
 * `$executeRaw` тут записує SQL і параметри (сам SQL виконується на живій БД — перевірка через
 * власний API з фейком AVD), `updateMany` — таблиця в пам'яті, що виконує `where`.
 */
const row = (id: string, over: Partial<CatalogMirrorRow> = {}): CatalogMirrorRow => ({
  supplierItemId: id,
  article: 'OC 90',
  brand: 'MAHLE',
  name: 'Фільтр',
  price: 127.89,
  currencyCode: 'UAH',
  priceType: 'personal',
  stock: [{ warehouseCode: 'w1', warehouseName: 'ЖИТОМИР', qty: 4, isCapped: false }],
  ...over,
});

function setup() {
  const statements: Prisma.Sql[] = [];
  const supplierCatalogItem = memoryTable([
    {
      id: 'old',
      orgId: ORG,
      connectionId: CONN,
      seenAt: new Date('2026-10-01T00:00:00Z'),
      deletedAt: null,
    },
    {
      id: 'other-conn',
      orgId: ORG,
      connectionId: 'c-2',
      seenAt: new Date('2026-10-01T00:00:00Z'),
      deletedAt: null,
    },
  ]);
  const prisma = {
    supplierCatalogItem,
    $executeRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push(Prisma.sql(strings, ...values));
      return Promise.resolve(1);
    }),
  } as unknown as PrismaService;
  const avd = {
    provider: 'AVD_TRADE',
    capabilities: { search: 'mirror' },
  } as unknown as SupplierAdapter;
  const service = new SupplierCatalogService(prisma, new SupplierAdapterRegistry([avd]), {
    add: vi.fn(),
  } as unknown as Queue);
  return { service, statements, supplierCatalogItem };
}

const conn = connectionCtx('AVD_TRADE');

describe('SupplierCatalogService.sync — дзеркало каталогу (BR-SCON-015)', () => {
  // guards: BR-SCON-015
  it('upsert за (підключення, id товару): явні orgId і syncVersion, повернений рядок оживає', async () => {
    const { service, statements } = setup();
    await service.sync(conn, async sink => {
      await sink.upsert([row('a'), row('b', { article: 'W 712/75', brand: null })]);
      return { count: 2 };
    });
    expect(statements).toHaveLength(1);
    const sql = statements[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain('ON CONFLICT ("connectionId", "supplierItemId") DO UPDATE SET');
    // Незмінний рядок лише «бачили» (seenAt): syncVersion і updatedAt — лише коли дані інші.
    expect(sql).toContain('"seenAt" = EXCLUDED."seenAt"');
    expect(sql).toMatch(
      /"syncVersion" = CASE WHEN \(.*\) IS DISTINCT FROM \(.*\) THEN "supplier_catalog_items"\."syncVersion" \+ 1 ELSE "supplier_catalog_items"\."syncVersion" END/,
    );
    expect(sql).toMatch(
      /"updatedAt" = CASE WHEN .* THEN now\(\) ELSE "supplier_catalog_items"\."updatedAt" END/,
    );
    expect(sql).toContain('"deletedAt" = NULL');
    expect(sql).toContain('WHERE "supplier_catalog_items"."orgId" = EXCLUDED."orgId"');
    const values = statements[0].values;
    expect(values.filter(v => v === ORG)).toHaveLength(2);
    expect(values).toEqual(
      expect.arrayContaining(['a', 'OC 90', 'OC90', 'MAHLE', 'b', 'W 712/75', 'W71275']),
    );
  });

  // guards: BR-SCON-015
  it('після повної синхронізації не побачені рядки цього підключення — soft delete; чужі не чіпаються', async () => {
    const { service, supplierCatalogItem } = setup();
    const res = await service.sync(conn, async sink => {
      await sink.upsert([row('a')]);
      return { count: 1 };
    });
    expect(res).toEqual({ count: 1, removed: 1 });
    expect(supplierCatalogItem.rows.find(r => r.id === 'old')!.deletedAt).toBeInstanceOf(Date);
    expect(supplierCatalogItem.rows.find(r => r.id === 'other-conn')!.deletedAt).toBeNull();
  });

  // guards: BR-SCON-015
  it('збій посередині синхронізації нічого не видаляє', async () => {
    const { service, supplierCatalogItem } = setup();
    await expect(
      service.sync(conn, async sink => {
        await sink.upsert([row('a')]);
        throw new Error('обрив на сторінці 2');
      }),
    ).rejects.toThrow('обрив');
    expect(supplierCatalogItem.rows.every(r => r.deletedAt === null)).toBe(true);
  });

  it('дубль id в одній сторінці — один рядок (останній); без ціни чи артикула — пропущено; пачки по 500', async () => {
    const { service, statements } = setup();
    const many = Array.from({ length: 1200 }, (_, i) => row(`id-${i}`));
    await service.upsert(
      conn,
      [
        row('x', { price: 1 }),
        row('x', { price: 2 }),
        row('y', { price: Number.NaN }),
        row('z', { article: '' }),
        ...many,
      ],
      new Date(),
    );
    expect(statements).toHaveLength(3); // 1201 унікальних → 500 + 500 + 201
    const first = statements[0].values;
    expect(first.filter(v => v === 'x')).toHaveLength(1);
    expect(first).toContain(2);
    expect(statements.flatMap(s => s.values)).not.toContain('y');
  });

  it('пошук по дзеркалу: лише невидалені рядки цього підключення за нормалізованим артикулом', async () => {
    const { service, supplierCatalogItem } = setup();
    supplierCatalogItem.rows.push(
      {
        id: 'm1',
        orgId: ORG,
        connectionId: CONN,
        supplierItemId: 'a',
        article: 'OC 90',
        articleNormalized: 'OC90',
        brand: 'MAHLE',
        name: 'Ф',
        price: 100,
        currencyCode: 'UAH',
        stock: [{ warehouseCode: 'w1', qty: 2, isCapped: false }],
        deletedAt: null,
      },
      {
        id: 'm2',
        orgId: ORG,
        connectionId: CONN,
        supplierItemId: 'b',
        article: 'OC 90',
        articleNormalized: 'OC90',
        brand: 'X',
        name: 'Ф',
        price: 90,
        currencyCode: 'UAH',
        stock: [{ warehouseCode: 'w1', qty: 2 }],
        deletedAt: new Date(),
      },
      {
        id: 'm3',
        orgId: ORG,
        connectionId: 'c-2',
        supplierItemId: 'c',
        article: 'OC 90',
        articleNormalized: 'OC90',
        brand: 'Y',
        name: 'Ф',
        price: 80,
        currencyCode: 'UAH',
        stock: [{ warehouseCode: 'w1', qty: 2 }],
        deletedAt: null,
      },
    );
    const offers = await service.searchMirror(conn, 'oc-90');
    expect(offers.map(o => o.offerKey)).toEqual(['a|w1']);
  });

  // guards: BR-SCON-006
  it('задача синхронізації: сталий jobId і removeOnFail: true (упала не блокує наступну)', async () => {
    const add = vi.fn(() => Promise.resolve({}));
    const service = new SupplierCatalogService(
      {} as PrismaService,
      new SupplierAdapterRegistry([]),
      { add } as unknown as Queue,
    );
    await expect(service.enqueueSync(ORG, CONN)).resolves.toBe(true);
    expect(add).toHaveBeenCalledWith(
      'sync',
      { orgId: ORG, connectionId: CONN },
      expect.objectContaining({
        attempts: 10,
        backoff: { type: 'exponential', delay: 60_000 },
        jobId: `supplier-catalog-${CONN}`,
        removeOnFail: true,
      }),
    );
  });

  // guards: BR-SCON-006
  it('sync-due: синхронізації кількох підключень — одним addBulk з тими самими опціями задачі', async () => {
    const addBulk = vi.fn(() => Promise.resolve([]));
    const service = new SupplierCatalogService(
      {} as PrismaService,
      new SupplierAdapterRegistry([]),
      { addBulk } as unknown as Queue,
    );
    await expect(service.enqueueSyncMany(ORG, [CONN, 'c-2'])).resolves.toBe(true);
    expect(addBulk).toHaveBeenCalledTimes(1);
    expect(addBulk).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'sync', data: { orgId: ORG, connectionId: CONN } }),
      {
        name: 'sync',
        data: { orgId: ORG, connectionId: 'c-2' },
        opts: expect.objectContaining({
          attempts: 10,
          backoff: { type: 'exponential', delay: 60_000 },
          jobId: 'supplier-catalog-c-2',
          removeOnFail: true,
        }),
      },
    ]);
    addBulk.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(service.enqueueSyncMany(ORG, [CONN])).resolves.toBe(false);
  });
});
