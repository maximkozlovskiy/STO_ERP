import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../../prisma/prisma.service';
import { normalizeArticle } from '../../../common/utils/normalize-article';
import { GoodMatcherService } from '../../goods/good-matcher.service';
import { IntegrationLogService } from '../../integration-logs/integration-log.service';
import { SupplierAdapterRegistry } from '../adapters/supplier-adapter-registry';
import { keepValidOffers } from '../adapters/adapter-utils';
import type { NormalizedOffer } from '../adapters/supplier-adapter.interface';
import { SupplierCatalogService } from '../catalog/supplier-catalog.service';
import { loadConnection, toConnectionContext } from '../connections/supplier-connection-context';
import { handleSupplierJobError } from '../processors/supplier-job-errors';
import { SupplierOffersService } from './supplier-offers.service';

export interface SupplierSearchJob {
  orgId: string;
  requestId: string;
}

/**
 * Задача `search` черги `supplier-search` (BR-SOFR-001, 002, 004): пропозиції підключення для
 * артикула → звірка з каталогом → у БД. Повтор задачі для завершеного запиту нічого не робить.
 */
@Injectable()
export class SupplierOfferSearchWorker {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SupplierAdapterRegistry,
    private readonly catalog: SupplierCatalogService,
    private readonly matcher: GoodMatcherService,
    private readonly integrationLog: IntegrationLogService,
    private readonly offers: SupplierOffersService,
  ) {}

  async run(job: Job<SupplierSearchJob>, token: string | undefined): Promise<void> {
    const { orgId, requestId } = job.data;
    const req = await this.prisma.supplierOfferRequest.findFirst({
      where: { id: requestId, orgId, deletedAt: null },
    });
    if (!req || req.status === 'DONE' || req.status === 'FAILED') return;
    const row = await loadConnection(this.prisma, orgId, req.connectionId);
    if (!row || !row.enabled) {
      await this.finish(orgId, req.id, req.batchId, 'FAILED', 'Підключення вимкнене або видалене');
      return;
    }
    const conn = toConnectionContext(row);
    const adapter = this.registry.get(conn.provider);
    await this.prisma.supplierOfferRequest.updateMany({
      where: { id: req.id, orgId },
      data: {
        status: 'RUNNING',
        attemptsMade: job.attemptsMade + 1,
        nextRetryAt: null,
        enqueueError: null,
      },
    });

    let found: NormalizedOffer[];
    try {
      found =
        adapter.capabilities.search === 'mirror'
          ? await this.catalog.searchMirror(conn, req.article)
          : await this.integrationLog.wrap(
              {
                orgId,
                provider: conn.provider,
                operation: 'search',
                documentType: 'SupplierOfferRequest',
                documentId: req.id,
              },
              () =>
                adapter.search(conn, {
                  article: req.article,
                  brand: req.brand,
                  includeAnalogs: req.includeAnalogs && adapter.capabilities.analogs,
                }),
            );
    } catch (e) {
      return handleSupplierJobError(job, token, e, {
        onFinal: message => this.finish(orgId, req.id, req.batchId, 'FAILED', message),
        onRetry: (message, at) =>
          this.prisma.supplierOfferRequest
            .updateMany({
              where: { id: req.id, orgId },
              data: { status: 'RETRYING', error: message, nextRetryAt: at },
            })
            .then(() => undefined),
      });
    }

    const offers = keepValidOffers(found);
    // BR-SOFR-004: звірка з товарами організації — код → артикул + бренд → штрихкод → артикул.
    const matches = offers.length
      ? await this.matcher.matchMany(
          orgId,
          offers.map(o => ({ article: o.article, brand: o.brand })),
        )
      : [];
    const fetchedAt = new Date();
    await this.prisma.$transaction(
      async tx => {
        if (offers.length) {
          await tx.supplierOffer.createMany({
            data: offers.map((o, i) => {
              const m = matches[i];
              const matchedGoodId = m?.status === 'matched' ? (m.good?.id ?? null) : null;
              // Аналог — пропозиція не на товар позиції: збіг з іншим товаром, інший артикул чи
              // позначка постачальника (крос), якщо збігу немає. Той самий артикул ІНШОГО бренду —
              // теж аналог (review 2026-10-18): збіг лише за артикулом (`matchedBy: 'article'`,
              // бренд пропозиції каталогу не відомий) чи неоднозначний збіг раніше проходили як
              // «той самий товар» і обирались навіть для позицій з наряду.
              const brandDiffers =
                !!req.brand &&
                !!o.brand &&
                normalizeArticle(req.brand) !== normalizeArticle(o.brand);
              const isAnalog = matchedGoodId
                ? matchedGoodId !== req.goodId || (m?.matchedBy === 'article' && brandDiffers)
                : o.isAnalog ||
                  normalizeArticle(o.article) !== req.articleNormalized ||
                  m?.status === 'ambiguous' ||
                  brandDiffers;
              return {
                orgId,
                requestId: req.id,
                connectionId: conn.id,
                supplierItemId: o.supplierItemId,
                article: o.article,
                articleNormalized: normalizeArticle(o.article),
                brand: o.brand,
                name: o.name,
                price: o.price,
                currencyCode: o.currencyCode,
                qty: o.qty,
                qtyIsLowerBound: o.qtyIsLowerBound,
                warehouseCode: o.warehouseCode,
                warehouseName: o.warehouseName,
                deliveryDays: o.deliveryDays,
                deliveryDate: o.deliveryDate,
                multiplicity: o.multiplicity,
                isAnalog,
                offerKey: o.offerKey,
                matchedGoodId,
                matchStatus: m?.status ?? null,
                fetchedAt,
              };
            }),
          });
        }
        await tx.supplierOfferRequest.updateMany({
          where: { id: req.id, orgId },
          data: { status: 'DONE', completedAt: fetchedAt, error: null, nextRetryAt: null },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    if (req.batchId) await this.offers.completeBatchIfDone(orgId, req.batchId);
  }

  private async finish(
    orgId: string,
    requestId: string,
    batchId: string | null,
    status: 'FAILED',
    error: string,
  ): Promise<void> {
    await this.prisma.supplierOfferRequest.updateMany({
      where: { id: requestId, orgId },
      data: { status, error, completedAt: new Date(), nextRetryAt: null },
    });
    if (batchId) await this.offers.completeBatchIfDone(orgId, batchId);
  }
}
