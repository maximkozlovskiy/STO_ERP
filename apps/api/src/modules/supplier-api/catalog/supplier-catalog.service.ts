import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { normalizeArticle } from '../../../common/utils/normalize-article';
import type {
  NormalizedOffer,
  SupplierConnectionContext,
} from '../adapters/supplier-adapter.interface';
import { mirrorRowToOffers } from '../adapters/avd-trade/avd-trade.mapper';

/** Межа рядків дзеркала на один артикул (той самий артикул у різних брендів). */
const MIRROR_HITS = 50;

/**
 * Дзеркало каталогу постачальника без пошуку за артикулом (AVD, BR-SCON-015): пошук пропозицій
 * — по локальній таблиці `SupplierCatalogItem`, без мережі.
 */
@Injectable()
export class SupplierCatalogService {
  constructor(private readonly prisma: PrismaService) {}

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
}
