import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Prisma, SupplierOffer, SupplierStrategy } from '@prisma/client';
import {
  TRANSACTION_TIMEOUT_MS,
  formatPersonName,
  translateError,
  type SupplierOfferSearchValues,
} from '@sto/shared';
import { PrismaService } from '../../../prisma/prisma.service';
import { getLocale } from '../../../common/tenant/tenant-context';
import { normalizeArticle } from '../../../common/utils/normalize-article';
import { SettingsService } from '../../settings/settings.service';
import { GoodsService } from '../../goods/goods.service';
import { BrandsService } from '../../brands/brands.service';
import { loadItemDtos } from '../../purchase-lists/purchase-lists.helpers';
import { canSeeItemCost, maskItemCost } from '../../purchase-lists/purchase-lists.mapper';
import { CLEAR_OFFER_SNAPSHOT, goodSwap } from '../../purchase-lists/purchase-list-offer-snapshot';
import type { PurchaseListItemResponseDto } from '../../purchase-lists/purchase-lists.dto';
import { SupplierPriceConverter } from './supplier-price-converter';
import { offerSelectability } from './offer-selectability';
import type {
  SupplierOfferBatchDto,
  SupplierOfferDto,
  SupplierOfferItemDto,
  SupplierOfferRequestDto,
  SupplierOfferSearchResultDto,
  SupplierProcurementSettingsDto,
} from './supplier-offers.dto';

const err = (key: string, params?: Record<string, string | number>) =>
  translateError(key, getLocale(), params);

const OPEN_ITEM = { status: 'OPEN' as const, purchaseOrderId: null, deletedAt: null };
const ITEM_FOR_OFFERS = {
  good: {
    select: {
      id: true,
      name: true,
      sku: true,
      unit: true,
      unitId: true,
      salePrice: true,
      goodCategoryId: true,
      brand: { select: { name: true } },
    },
  },
} as const satisfies Prisma.PurchaseListItemInclude;
type ItemForOffers = Prisma.PurchaseListItemGetPayload<{ include: typeof ITEM_FOR_OFFERS }>;

const REQUEST_INCLUDE = {
  connection: {
    select: {
      id: true,
      name: true,
      provider: true,
      counterpartyId: true,
      enabled: true,
      deletedAt: true,
      catalogSyncedAt: true,
      counterparty: { select: { firstName: true, lastName: true, companyName: true } },
    },
  },
} as const satisfies Prisma.SupplierOfferRequestInclude;
type RequestRow = Prisma.SupplierOfferRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

/** Межа пропозицій на один запит у відповіді (постачальник може віддати сотні складів). */
const OFFERS_PER_REQUEST = 200;

/** Налаштування, від яких залежить показ пропозицій. */
interface OfferSettings {
  ttlMs: number;
  catalogIntervalMs: number;
  policy: Awaited<ReturnType<SettingsService['getOrganisationSettings']>>['supplierAnalogPolicy'];
}

/**
 * Пропозиції постачальників для позицій списку купівлі (BR-SOFR-002…006, 010).
 * Пошук — через чергу (`supplier-search`), результати — у БД: UI опитує batch, а офлайн показує
 * останні відомі пропозиції. Вибір пропозиції пише знімок у позицію (ціна — у гривні).
 */
@Injectable()
export class SupplierOffersService {
  private readonly logger = new Logger(SupplierOffersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly converter: SupplierPriceConverter,
    private readonly goods: GoodsService,
    private readonly brands: BrandsService,
    @InjectQueue('supplier-search') private readonly searchQueue: Queue,
  ) {}

  /**
   * BR-SOFR-002: batch + запит на кожну пару (позиція × увімкнене підключення). Свіжий виконаний
   * запит того самого підключення, артикулу й бренду — повторно (`fromCache`), без задачі.
   */
  async search(
    orgId: string,
    dto: SupplierOfferSearchValues,
    opts: {
      userId?: string;
      role?: string;
      purpose?: 'MANUAL' | 'AUTO';
      strategy?: SupplierStrategy;
    } = {},
  ): Promise<SupplierOfferSearchResultDto> {
    const ids = Array.from(new Set(dto.itemIds));
    const items = await this.loadItems(orgId, ids);
    const [connections, s] = await Promise.all([
      this.prisma.supplierConnection.findMany({
        where: { orgId, enabled: true, deletedAt: null },
        select: { id: true },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        take: 50,
      }),
      this.settings.getOrganisationSettings(orgId),
    ]);
    const includeAnalogs = dto.includeAnalogs ?? true;
    const skippedItemIds: string[] = [];
    const now = new Date();
    const freshSince = new Date(now.getTime() - s.supplierOfferTtlMinutes * 60_000);

    // Пари (позиція × підключення) і кандидати кешу — ДО транзакції одним запитом: раніше
    // findFirst + create на кожну пару в транзакції без timeout (100 позицій × 50 підключень
    // упиралися в стандартні 5 с інтерактивної транзакції).
    type Pair = {
      itemId: string;
      goodId: string;
      article: string;
      articleNormalized: string;
      brand: string | null;
      connectionId: string;
    };
    const pairs: Pair[] = [];
    for (const item of items) {
      const article = item.good.sku?.trim() ?? '';
      const articleNormalized = normalizeArticle(article);
      if (!articleNormalized) {
        skippedItemIds.push(item.id);
        continue;
      }
      const brand = item.good.brand?.name ?? null;
      for (const c of connections) {
        pairs.push({
          itemId: item.id,
          goodId: item.goodId,
          article,
          articleNormalized,
          brand,
          connectionId: c.id,
        });
      }
    }
    const cacheKey = (connectionId: string, articleNormalized: string, brand: string | null) =>
      `${connectionId}|${articleNormalized}|${brand ?? ''}`;
    const cacheHits = new Map<string, string>();
    if (!dto.refresh && pairs.length > 0) {
      const candidates = await this.prisma.supplierOfferRequest.findMany({
        where: {
          orgId,
          connectionId: { in: connections.map(c => c.id) },
          articleNormalized: { in: Array.from(new Set(pairs.map(p => p.articleNormalized))) },
          includeAnalogs,
          status: 'DONE',
          cacheOfId: null,
          completedAt: { gte: freshSince },
          deletedAt: null,
        },
        orderBy: { completedAt: 'desc' },
        select: { id: true, connectionId: true, articleNormalized: true, brand: true },
        take: 5000,
      });
      // Перший (найсвіжіший) виконаний запит на (підключення, артикул, бренд).
      for (const r of candidates) {
        const k = cacheKey(r.connectionId, r.articleNormalized, r.brand);
        if (!cacheHits.has(k)) cacheHits.set(k, r.id);
      }
    }

    const { batchId, toEnqueue } = await this.prisma.$transaction(
      async tx => {
        const batch = await tx.supplierOfferBatch.create({
          data: {
            orgId,
            purpose: opts.purpose ?? 'MANUAL',
            strategy: opts.strategy ?? null,
            requestedBy: opts.userId ?? null,
            itemIds: ids,
          },
          select: { id: true },
        });
        const rows: Prisma.SupplierOfferRequestCreateManyInput[] = pairs.map(p => {
          const base = {
            orgId,
            batchId: batch.id,
            connectionId: p.connectionId,
            purchaseListItemId: p.itemId,
            goodId: p.goodId,
            article: p.article,
            articleNormalized: p.articleNormalized,
            brand: p.brand,
            includeAnalogs,
          };
          const cachedId = cacheHits.get(cacheKey(p.connectionId, p.articleNormalized, p.brand));
          return cachedId
            ? { ...base, status: 'DONE', fromCache: true, cacheOfId: cachedId, completedAt: now }
            : base;
        });
        const created = rows.length
          ? await tx.supplierOfferRequest.createManyAndReturn({
              data: rows,
              select: { id: true, fromCache: true },
            })
          : [];
        return { batchId: batch.id, toEnqueue: created.filter(r => !r.fromCache).map(r => r.id) };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    let queueUnavailable = false;
    for (const requestId of toEnqueue) {
      if (!(await this.enqueueSearch(orgId, requestId))) queueUnavailable = true;
    }
    if (toEnqueue.length === 0) await this.completeBatchIfDone(orgId, batchId);
    const batch = await this.getBatch(orgId, batchId, opts.role);
    return { ...batch, queueUnavailable, noConnections: connections.length === 0, skippedItemIds };
  }

  /** Постановка пошуку в чергу; false — Redis недоступний (рядок лишається QUEUED для sweep). */
  async enqueueSearch(orgId: string, requestId: string): Promise<boolean> {
    try {
      await this.searchQueue.add(
        'search',
        { orgId, requestId },
        {
          attempts: 10,
          backoff: { type: 'exponential', delay: 30_000 },
          jobId: `supplier-search-${requestId}`,
          removeOnComplete: true,
          // Сталий jobId: failed-задача з тим самим id блокувала б перепостановку sweep-ом.
          removeOnFail: true,
        },
      );
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Пошук ${requestId} не поставлено в чергу: ${message}`);
      await this.prisma.supplierOfferRequest.updateMany({
        where: { id: requestId, orgId, status: 'QUEUED' },
        data: { enqueueError: message.slice(0, 300) },
      });
      return false;
    }
  }

  /** Batch завершено, коли всі його запити DONE / FAILED. */
  async completeBatchIfDone(orgId: string, batchId: string): Promise<void> {
    const open = await this.prisma.supplierOfferRequest.count({
      where: { orgId, batchId, deletedAt: null, status: { in: ['QUEUED', 'RUNNING', 'RETRYING'] } },
    });
    if (open > 0) return;
    await this.prisma.supplierOfferBatch.updateMany({
      where: { id: batchId, orgId, completedAt: null },
      data: { completedAt: new Date() },
    });
  }

  /** BR-SOFR-002: стан batch для опитування UI — по позиціях і підключеннях, з пропозиціями. */
  async getBatch(orgId: string, batchId: string, role?: string): Promise<SupplierOfferBatchDto> {
    const batch = await this.prisma.supplierOfferBatch.findFirst({
      where: { id: batchId, orgId, deletedAt: null },
    });
    if (!batch) throw new NotFoundException(err('err.supplierApi.batchNotFound'));
    const itemIds = Array.isArray(batch.itemIds) ? (batch.itemIds as string[]) : [];
    const [items, requests] = await Promise.all([
      this.prisma.purchaseListItem.findMany({
        where: { orgId, id: { in: itemIds }, deletedAt: null },
        include: ITEM_FOR_OFFERS,
        take: itemIds.length || 1,
      }),
      this.prisma.supplierOfferRequest.findMany({
        where: { orgId, batchId, deletedAt: null },
        include: REQUEST_INCLUDE,
        orderBy: { createdAt: 'asc' },
        take: 5000,
      }),
    ]);
    const itemDtos = await this.buildItems(orgId, items, requests, role);
    const done = requests.every(r => r.status === 'DONE' || r.status === 'FAILED');
    return {
      id: batch.id,
      purpose: batch.purpose,
      strategy: batch.strategy,
      done,
      completedAt: batch.completedAt?.toISOString() ?? null,
      createdAt: batch.createdAt.toISOString(),
      items: itemIds
        .map(id => itemDtos.find(i => i.itemId === id))
        .filter((i): i is SupplierOfferItemDto => !!i),
    };
  }

  /** Стратегія за замовчуванням і TTL — для діалогів пропозицій (комірник налаштувань не читає). */
  async procurementSettings(orgId: string): Promise<SupplierProcurementSettingsDto> {
    const s = await this.settings.getOrganisationSettings(orgId);
    return {
      defaultStrategy: s.supplierDefaultStrategy,
      offerTtlMinutes: s.supplierOfferTtlMinutes,
      allowSplit: s.supplierAllowSplit,
      allowAnalogsInAuto: s.supplierAllowAnalogsInAuto,
      analogPolicy: s.supplierAnalogPolicy,
    };
  }

  /**
   * BR-SOFR-003: останні відомі пропозиції позиції — без мережі: найсвіжіший запит кожного
   * підключення для цієї позиції. Застарілі позначені `stale`, не видалені.
   */
  async itemOffers(orgId: string, itemId: string, role?: string): Promise<SupplierOfferItemDto> {
    const [item] = await this.loadItems(orgId, [itemId]);
    const all = await this.prisma.supplierOfferRequest.findMany({
      where: { orgId, purchaseListItemId: itemId, deletedAt: null },
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    // Найсвіжіший запит кожного підключення; якщо він ще не виконаний (немає зв'язку) —
    // найсвіжіший виконаний: офлайн показуються останні відомі пропозиції.
    const pick = new Map<string, RequestRow>();
    for (const r of all) {
      const prev = pick.get(r.connectionId);
      if (!prev || (prev.status !== 'DONE' && r.status === 'DONE')) pick.set(r.connectionId, r);
    }
    const requests = [...pick.values()];
    const [dto] = await this.buildItems(orgId, [item], requests, role);
    return dto;
  }

  /**
   * BR-SOFR-006: ручний вибір. Лише OPEN-позиція (CAS, BR-PL-005); пропозиція — з запитів цієї
   * позиції; ціна — у гривні за курсом зараз; аналог — за політикою (BR-SOFR-005).
   */
  async chooseOffer(
    orgId: string,
    itemId: string,
    offerId: string,
    role?: string,
  ): Promise<PurchaseListItemResponseDto> {
    const [item] = await this.loadItems(orgId, [itemId]);
    if (item.status !== 'OPEN' || item.purchaseOrderId !== null) {
      throw new BadRequestException(err('err.purchaseList.itemNotOpen'));
    }
    const offer = await this.prisma.supplierOffer.findFirst({
      where: { id: offerId, orgId, deletedAt: null },
      include: { connection: { select: { counterpartyId: true, enabled: true, deletedAt: true } } },
    });
    const ownRequest = offer
      ? await this.offerRequestOfItem(orgId, item.id, offer.requestId)
      : null;
    if (!offer || !ownRequest) {
      throw new NotFoundException(err('err.supplierApi.offerNotFound'));
    }
    if (!offer.connection.enabled || offer.connection.deletedAt) {
      throw new BadRequestException(err('err.supplierApi.connectionDisabled'));
    }
    const s = await this.settings.getOrganisationSettings(orgId);
    const priceUah = await this.converter.forOrg(orgId)(offer.currencyCode, Number(offer.price));
    const sel = offerSelectability({
      isAnalog: offer.isAnalog,
      matchStatus: offer.matchStatus,
      matchedGoodId: offer.matchedGoodId,
      itemSource: item.source,
      itemOpen: true,
      policy: s.supplierAnalogPolicy,
      priceUah,
    });
    if (sel.reason === 'noExchangeRate') {
      throw new BadRequestException(
        err('err.supplierApi.noExchangeRate', { currency: offer.currencyCode }),
      );
    }
    if (!sel.selectable) throw new BadRequestException(err('err.supplierApi.analogNotSelectable'));

    const write = async (targetGoodId: string | null) => {
      const res = await this.prisma.purchaseListItem.updateMany({
        where: { id: item.id, orgId, ...OPEN_ITEM, quantity: item.quantity, goodId: item.goodId },
        data: {
          supplierId: offer.connection.counterpartyId,
          expectedPrice: priceUah as number,
          ...snapshotOf(offer, 'MANUAL'),
          ...(targetGoodId && targetGoodId !== item.goodId ? goodSwap(item, targetGoodId) : {}),
        },
      });
      if (res.count !== 1) throw new ConflictException(err('err.purchaseList.concurrentChange'));
    };

    if (!sel.replacesGood) {
      // Не аналог — пропозиція на товар, для якого її шукали: після попередньої заміни аналогом
      // це оригінал позиції, і він повертається (інакше рядок замовлення піде з артикулом
      // оригіналу під товаром-аналогом).
      await write(ownRequest.goodId);
    } else if (offer.matchStatus === 'matched' && offer.matchedGoodId) {
      const g = await this.prisma.good.findFirst({
        where: { id: offer.matchedGoodId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!g) throw new BadRequestException(err('err.supplierApi.analogNotSelectable'));
      await write(g.id);
    } else {
      await this.chooseNewAnalog(orgId, item, offer, priceUah as number, write);
    }
    return this.itemDto(orgId, item.id, role);
  }

  /** BR-SOFR-006: зняти вибір — знімок очищається, постачальник і ціна лишаються. */
  async clearOffer(
    orgId: string,
    itemId: string,
    role?: string,
  ): Promise<PurchaseListItemResponseDto> {
    const [item] = await this.loadItems(orgId, [itemId]);
    if (item.status !== 'OPEN' || item.purchaseOrderId !== null) {
      throw new BadRequestException(err('err.purchaseList.itemNotOpen'));
    }
    const res = await this.prisma.purchaseListItem.updateMany({
      where: { id: item.id, orgId, ...OPEN_ITEM, quantity: item.quantity, offerKey: item.offerKey },
      data: { ...CLEAR_OFFER_SNAPSHOT },
    });
    if (res.count !== 1) throw new ConflictException(err('err.purchaseList.concurrentChange'));
    return this.itemDto(orgId, item.id, role);
  }

  // ─── Допоміжне ────────────────────────────────────────────

  private async itemDto(
    orgId: string,
    id: string,
    role?: string,
  ): Promise<PurchaseListItemResponseDto> {
    const [dto] = await loadItemDtos(this.prisma, orgId, [id]);
    return maskItemCost([dto], role)[0];
  }

  private async loadItems(orgId: string, ids: string[]): Promise<ItemForOffers[]> {
    const items = await this.prisma.purchaseListItem.findMany({
      where: { orgId, id: { in: ids }, deletedAt: null, list: { deletedAt: null } },
      include: ITEM_FOR_OFFERS,
      take: ids.length,
    });
    if (items.length !== ids.length) {
      const found = new Set(items.map(i => i.id));
      throw new NotFoundException(
        err('err.purchaseList.itemsNotFound', {
          missing: ids.filter(i => !found.has(i)).join(', '),
        }),
      );
    }
    return ids.map(id => items.find(i => i.id === id) as ItemForOffers);
  }

  /** Власний запит позиції, якому належить пропозиція (свій чи той, з якого взято кеш). */
  private async offerRequestOfItem(
    orgId: string,
    itemId: string,
    requestId: string,
  ): Promise<{ goodId: string | null } | null> {
    return this.prisma.supplierOfferRequest.findFirst({
      where: {
        orgId,
        purchaseListItemId: itemId,
        deletedAt: null,
        OR: [{ id: requestId }, { cacheOfId: requestId }],
      },
      select: { goodId: true },
    });
  }

  /**
   * BR-SOFR-005, CREATE_AND_REPLACE: аналог, якого немає в каталозі. Під advisory-блокуванням за
   * (організація, нормалізований артикул): спершу шукається товар, створений раніше (той самий
   * артикул і бренд — повторний вибір чи одночасний клік), і лише без нього створюється новий —
   * ціна продажу, одиниця й категорія як у товару позиції. Якщо позицію тим часом змінили (409),
   * щойно створений товар знімається (soft delete) — каталог не засмічується сиротами. Після
   * створення пропозиції того ж підключення, артикулу й бренду вважаються знайденими в каталозі.
   */
  private async chooseNewAnalog(
    orgId: string,
    item: ItemForOffers,
    offer: SupplierOffer & { connection: { counterpartyId: string } },
    priceUah: number,
    write: (goodId: string) => Promise<void>,
  ): Promise<void> {
    const skuNormalized = normalizeArticle(offer.article);
    const brand = await this.brands.resolveByNameOrSynonym(orgId, offer.brand);
    await this.prisma.$transaction(
      async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier-analog:${orgId}:${skuNormalized}`}))`;
        const existing = await tx.good.findFirst({
          where: { orgId, skuNormalized, brandId: brand?.id ?? null, deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (existing) {
          await write(existing.id);
          return;
        }
        const created = await this.goods.create(
          orgId,
          {
            name: offer.name?.trim() || [offer.brand, offer.article].filter(Boolean).join(' '),
            sku: offer.article,
            brandId: brand?.id,
            unit: item.good.unit ?? 'шт',
            unitId: item.good.unitId ?? undefined,
            goodCategoryId: item.good.goodCategoryId ?? undefined,
            purchasePrice: priceUah,
            salePrice: Number(item.good.salePrice ?? 0),
            preferredSupplierId: offer.connection.counterpartyId,
            notes: `Аналог для «${item.good.name}» (пропозиція постачальника)`,
          },
          'OWNER',
        );
        try {
          await write(created.id);
        } catch (e) {
          await this.prisma.good.updateMany({
            where: { id: created.id, orgId },
            data: { deletedAt: new Date() },
          });
          throw e;
        }
        await this.prisma.supplierOffer.updateMany({
          where: {
            orgId,
            connectionId: offer.connectionId,
            articleNormalized: offer.articleNormalized,
            brand: offer.brand,
            matchedGoodId: null,
            deletedAt: null,
          },
          data: { matchedGoodId: created.id, matchStatus: 'matched' },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  private async offerSettings(orgId: string): Promise<OfferSettings> {
    const s = await this.settings.getOrganisationSettings(orgId);
    return {
      ttlMs: s.supplierOfferTtlMinutes * 60_000,
      catalogIntervalMs: s.supplierCatalogSyncIntervalMinutes * 60_000,
      policy: s.supplierAnalogPolicy,
    };
  }

  private async buildItems(
    orgId: string,
    items: ItemForOffers[],
    requests: RequestRow[],
    role: string | undefined,
  ): Promise<SupplierOfferItemDto[]> {
    const s = await this.offerSettings(orgId);
    const sourceIds = requests.map(r => r.cacheOfId ?? r.id);
    const offers = sourceIds.length
      ? await this.prisma.supplierOffer.findMany({
          where: { orgId, requestId: { in: sourceIds }, deletedAt: null },
          orderBy: [{ price: 'asc' }],
          take: OFFERS_PER_REQUEST * sourceIds.length,
        })
      : [];
    const byRequest = new Map<string, SupplierOffer[]>();
    for (const o of offers) byRequest.set(o.requestId, [...(byRequest.get(o.requestId) ?? []), o]);
    const fetchedAt = new Map<string, Date | null>();
    if (requests.some(r => r.cacheOfId)) {
      const sourceIds = [...new Set(requests.flatMap(r => (r.cacheOfId ? [r.cacheOfId] : [])))];
      const sources = await this.prisma.supplierOfferRequest.findMany({
        where: { orgId, id: { in: sourceIds }, deletedAt: null },
        select: { id: true, completedAt: true },
        take: sourceIds.length,
      });
      for (const src of sources) fetchedAt.set(src.id, src.completedAt);
    }
    const toUah = this.converter.forOrg(orgId);
    const showPrices = canSeeItemCost(role);
    const now = Date.now();
    const out: SupplierOfferItemDto[] = [];
    for (const item of items) {
      const itemOpen = item.status === 'OPEN' && item.purchaseOrderId === null;
      const reqDtos: SupplierOfferRequestDto[] = [];
      for (const r of requests.filter(x => x.purchaseListItemId === item.id)) {
        const sourceId = r.cacheOfId ?? r.id;
        const got = r.cacheOfId ? (fetchedAt.get(r.cacheOfId) ?? null) : r.completedAt;
        const stale = !!got && now - got.getTime() > s.ttlMs;
        const offerDtos: SupplierOfferDto[] = [];
        for (const o of (byRequest.get(sourceId) ?? []).slice(0, OFFERS_PER_REQUEST)) {
          const priceUah = await toUah(o.currencyCode, Number(o.price));
          const sel = offerSelectability({
            isAnalog: o.isAnalog,
            matchStatus: o.matchStatus,
            matchedGoodId: o.matchedGoodId,
            itemSource: item.source,
            itemOpen,
            connectionDisabled: !r.connection.enabled || !!r.connection.deletedAt,
            policy: s.policy,
            priceUah,
          });
          offerDtos.push({
            id: o.id,
            connectionId: o.connectionId,
            supplierItemId: o.supplierItemId,
            article: o.article,
            brand: o.brand,
            name: o.name,
            price: showPrices ? Number(o.price) : null,
            currencyCode: o.currencyCode,
            priceUah: showPrices ? priceUah : null,
            qty: o.qty,
            qtyIsLowerBound: o.qtyIsLowerBound,
            warehouseCode: o.warehouseCode,
            warehouseName: o.warehouseName,
            deliveryDays: o.deliveryDays,
            deliveryDate: o.deliveryDate?.toISOString() ?? null,
            multiplicity: o.multiplicity,
            isAnalog: o.isAnalog,
            offerKey: o.offerKey,
            matchedGoodId: o.matchedGoodId,
            matchStatus: o.matchStatus,
            fetchedAt: o.fetchedAt.toISOString(),
            stale: now - o.fetchedAt.getTime() > s.ttlMs,
            selectable: sel.selectable,
            notSelectableReason: sel.reason,
            replacesGood: sel.replacesGood,
            chosen: item.offerKey === o.offerKey && item.offerConnectionId === o.connectionId,
          });
        }
        const c = r.connection;
        reqDtos.push({
          id: r.id,
          connectionId: r.connectionId,
          connectionName: c.name ?? c.provider,
          provider: c.provider,
          supplierId: c.counterpartyId,
          supplierName: formatPersonName(
            c.counterparty.lastName,
            c.counterparty.firstName,
            c.counterparty.companyName,
          ),
          status: r.status,
          fromCache: r.fromCache,
          fetchedAt: got?.toISOString() ?? null,
          stale,
          mirrorStale:
            c.provider === 'AVD_TRADE' &&
            (!c.catalogSyncedAt || now - c.catalogSyncedAt.getTime() > 2 * s.catalogIntervalMs),
          nextRetryAt: r.nextRetryAt?.toISOString() ?? null,
          error: r.error,
          offers: offerDtos,
        });
      }
      out.push({
        itemId: item.id,
        goodId: item.goodId,
        goodName: item.good.name,
        article: item.good.sku,
        brand: item.good.brand?.name ?? null,
        quantity: item.quantity,
        status: item.status,
        source: item.source,
        chosenOfferKey: item.offerKey,
        chosenConnectionId: item.offerConnectionId,
        chosenBy: item.offerChosenBy,
        requests: reqDtos,
      });
    }
    return out;
  }
}

/** Знімок пропозиції для позиції (BR-SOFR-006): ціна й валюта — як у постачальника. */
export function snapshotOf(offer: SupplierOffer, chosenBy: 'MANUAL' | 'AUTO') {
  return {
    offerConnectionId: offer.connectionId,
    offerKey: offer.offerKey,
    offerSupplierItemId: offer.supplierItemId,
    offerArticle: offer.article,
    offerBrand: offer.brand,
    offerWarehouseCode: offer.warehouseCode,
    offerWarehouseName: offer.warehouseName,
    offerDeliveryDays: offer.deliveryDays,
    offerDeliveryDate: offer.deliveryDate,
    offerPrice: offer.price,
    offerCurrencyCode: offer.currencyCode,
    offerMultiplicity: offer.multiplicity,
    offerIsAnalog: offer.isAnalog,
    offeredAt: new Date(),
    offerChosenBy: chosenBy,
  };
}
