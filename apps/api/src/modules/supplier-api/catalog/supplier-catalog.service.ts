import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { translateError } from '@sto/shared';
import { PrismaService } from '../../../prisma/prisma.service';
import { getLocale } from '../../../common/tenant/tenant-context';
import { normalizeArticle } from '../../../common/utils/normalize-article';
import type {
  CatalogMirrorRow,
  CatalogSink,
  NormalizedOffer,
  SupplierConnectionContext,
} from '../adapters/supplier-adapter.interface';
import { SupplierAdapterRegistry } from '../adapters/supplier-adapter-registry';
import { mirrorRowToOffers } from '../adapters/avd-trade/avd-trade.mapper';

/** Межа рядків дзеркала на один артикул (той самий артикул у різних брендів). */
const MIRROR_HITS = 50;
/** Рядків на один INSERT: 18 параметрів × 500 ≪ 32767 (межа параметрів Postgres). */
const UPSERT_CHUNK = 500;

const err = (key: string, params?: Record<string, string>) =>
  translateError(key, getLocale(), params);

/**
 * Дзеркало каталогу постачальника без пошуку за артикулом (AVD, BR-SCON-015). Пошук пропозицій —
 * по локальній таблиці `SupplierCatalogItem`, без мережі; синхронізація — задача черги
 * `supplier-catalog`: масовий upsert сирим SQL (`INSERT … ON CONFLICT`) з явними `orgId` і
 * `syncVersion`, а рядки, не побачені в повній синхронізації, — soft delete.
 */
@Injectable()
export class SupplierCatalogService {
  private readonly logger = new Logger(SupplierCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SupplierAdapterRegistry,
    @InjectQueue('supplier-catalog') private readonly catalogQueue: Queue,
  ) {}

  async searchMirror(conn: SupplierConnectionContext, article: string): Promise<NormalizedOffer[]> {
    const articleNormalized = normalizeArticle(article);
    if (!articleNormalized) return [];
    const rows = await this.prisma.supplierCatalogItem.findMany({
      where: { orgId: conn.orgId, connectionId: conn.id, articleNormalized, deletedAt: null },
      take: MIRROR_HITS,
    });
    return rows.flatMap(r =>
      mirrorRowToOffers({
        supplierItemId: r.supplierItemId,
        article: r.article,
        brand: r.brand,
        name: r.name,
        price: Number(r.price),
        currencyCode: r.currencyCode,
        stock: r.stock,
      }),
    );
  }

  /** Кнопка «Синхронізувати каталог» (OWNER, ADMIN): задача в чергу; false — Redis недоступний. */
  async requestSync(orgId: string, connectionId: string): Promise<{ queued: boolean }> {
    const conn = await this.prisma.supplierConnection.findFirst({
      where: { id: connectionId, orgId, deletedAt: null },
      select: { id: true, provider: true },
    });
    if (!conn) throw new NotFoundException(err('err.supplierConnection.notFound'));
    if (this.registry.get(conn.provider).capabilities.search !== 'mirror') {
      throw new BadRequestException(
        err('err.supplierConnection.invalidOptions', {
          details: 'дзеркало каталогу потрібне лише AVD',
        }),
      );
    }
    await this.prisma.supplierConnection.updateMany({
      where: { id: connectionId, orgId, deletedAt: null },
      data: { catalogSyncStatus: 'QUEUED', catalogSyncError: null },
    });
    return { queued: await this.enqueueSync(orgId, connectionId) };
  }

  async enqueueSync(orgId: string, connectionId: string): Promise<boolean> {
    try {
      // Сталий jobId: поки синхронізація підключення йде, повторне натискання нової не ставить.
      await this.catalogQueue.add(
        'sync',
        { orgId, connectionId },
        {
          attempts: 10,
          backoff: { type: 'exponential', delay: 60_000 },
          jobId: `supplier-catalog-${connectionId}`,
          removeOnComplete: true,
          removeOnFail: 200,
        },
      );
      return true;
    } catch (e) {
      this.logger.warn(
        `Синхронізацію каталогу ${connectionId} не поставлено в чергу: ${e instanceof Error ? e.message : e}`,
      );
      return false;
    }
  }

  /**
   * Повна синхронізація: адаптер віддає сторінки → upsert; після успіху рядки, не побачені з
   * початку цієї синхронізації, позначаються видаленими. Збій посередині нічого не видаляє.
   */
  async sync(
    conn: SupplierConnectionContext,
    run: (sink: CatalogSink) => Promise<{ count: number }>,
  ): Promise<{ count: number; removed: number }> {
    const startedAt = new Date();
    const { count } = await run({ upsert: rows => this.upsert(conn, rows, startedAt) });
    const removed = await this.prisma.supplierCatalogItem.updateMany({
      where: {
        orgId: conn.orgId,
        connectionId: conn.id,
        deletedAt: null,
        seenAt: { lt: startedAt },
      },
      data: { deletedAt: new Date() },
    });
    return { count, removed: removed.count };
  }

  /** Масовий upsert за (підключення, id товару постачальника); повернений рядок — «оживає». */
  async upsert(
    conn: SupplierConnectionContext,
    rows: CatalogMirrorRow[],
    seenAt: Date,
  ): Promise<void> {
    // Дубль id в одному INSERT … ON CONFLICT — помилка Postgres; останній рядок перемагає.
    const unique = new Map<string, CatalogMirrorRow>();
    for (const r of rows) {
      if (r.supplierItemId && r.article && Number.isFinite(r.price))
        unique.set(r.supplierItemId, r);
    }
    const all = [...unique.values()];
    for (let i = 0; i < all.length; i += UPSERT_CHUNK) {
      const values = all.slice(i, i + UPSERT_CHUNK).map(
        r => Prisma.sql`(
          gen_random_uuid(), ${conn.orgId}::uuid, ${conn.id}::uuid, ${r.supplierItemId}, ${r.article},
          ${normalizeArticle(r.article)}, ${r.brand}, ${r.brand ? normalizeArticle(r.brand) : null},
          ${r.name}, ${r.price}::numeric, ${r.currencyCode}, ${r.priceType},
          ${JSON.stringify(r.stock)}::jsonb, ${seenAt}, 1, now(), now(), NULL
        )`,
      );
      await this.prisma.$executeRaw`
        INSERT INTO "supplier_catalog_items" (
          "id", "orgId", "connectionId", "supplierItemId", "article",
          "articleNormalized", "brand", "brandNormalized",
          "name", "price", "currencyCode", "priceType",
          "stock", "seenAt", "syncVersion", "createdAt", "updatedAt", "deletedAt"
        ) VALUES ${Prisma.join(values)}
        ON CONFLICT ("connectionId", "supplierItemId") DO UPDATE SET
          "article" = EXCLUDED."article",
          "articleNormalized" = EXCLUDED."articleNormalized",
          "brand" = EXCLUDED."brand",
          "brandNormalized" = EXCLUDED."brandNormalized",
          "name" = EXCLUDED."name",
          "price" = EXCLUDED."price",
          "currencyCode" = EXCLUDED."currencyCode",
          "priceType" = EXCLUDED."priceType",
          "stock" = EXCLUDED."stock",
          "seenAt" = EXCLUDED."seenAt",
          "syncVersion" = "supplier_catalog_items"."syncVersion" + 1,
          "updatedAt" = now(),
          "deletedAt" = NULL
        WHERE "supplier_catalog_items"."orgId" = EXCLUDED."orgId"`;
    }
  }
}
