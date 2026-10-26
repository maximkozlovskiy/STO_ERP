import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Prisma, SupplierOffer, SupplierOfferBatch, SupplierStrategy } from '@prisma/client';
import {
  TRANSACTION_TIMEOUT_MS,
  formatPersonName,
  type SupplierOfferSearchValues,
} from '@sto/shared';
import { PrismaService } from '../../../prisma/prisma.service';
import { err } from '../../../common/utils/err';
import { groupBy } from '../../../common/utils/array';
import { normalizeArticle } from '../../../common/utils/normalize-article';
import { SettingsService } from '../../settings/settings.service';
import { GoodsService } from '../../goods/goods.service';
import { BrandsService } from '../../brands/brands.service';
import {
  conflict,
  isItemOpen,
  loadItemDtos,
  OPEN_ITEM_WHERE,
} from '../../purchase-lists/purchase-lists.helpers';
import { canSeeItemCost, maskItemCost } from '../../purchase-lists/purchase-lists.mapper';
import {
  applyOfferData,
  CLEAR_OFFER_SNAPSHOT,
  goodSwap,
} from '../../purchase-lists/purchase-list-offer-snapshot';
import type { PurchaseListItemResponseDto } from '../../purchase-lists/purchase-lists.dto';
import { SupplierPriceConverter } from './supplier-price-converter';
import { offerSelectability } from './offer-selectability';
import type {
  SupplierOfferBatchDto,
  SupplierOfferBatchStatusDto,
  SupplierOfferDto,
  SupplierOfferItemDto,
  SupplierOfferRequestDto,
  SupplierOfferSearchResultDto,
  SupplierProcurementSettingsDto,
} from './supplier-offers.dto';

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
/** Задач пошуку на один `addBulk` — межа розміру однієї транзакції Redis. */
const ENQUEUE_CHUNK = 500;

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
    const [items, connections, s] = await Promise.all([
      this.loadItems(orgId, ids),
      // Поля підключення для відповіді — одразу: batch будується з уже прочитаного, без getBatch.
      this.prisma.supplierConnection.findMany({
        where: { orgId, enabled: true, deletedAt: null },
        select: REQUEST_INCLUDE.connection.select,
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

    const allCached = pairs.every(p =>
      cacheHits.has(cacheKey(p.connectionId, p.articleNormalized, p.brand)),
    );
    const { batch, created } = await this.prisma.$transaction(
      async tx => {
        const batch = await tx.supplierOfferBatch.create({
          data: {
            orgId,
            purpose: opts.purpose ?? 'MANUAL',
            strategy: opts.strategy ?? null,
            requestedBy: opts.userId ?? null,
            itemIds: ids,
            // Задач немає (усе з кешу чи нема пар) — batch завершено одразу.
            completedAt: allCached ? now : null,
          },
          select: { id: true, purpose: true, strategy: true, completedAt: true, createdAt: true },
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
          ? await tx.supplierOfferRequest.createManyAndReturn({ data: rows })
          : [];
        return { batch, created };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    const toEnqueue = created.filter(r => !r.fromCache).map(r => r.id);
    const queueUnavailable = !(await this.enqueueSearchMany(orgId, toEnqueue));
    // Відповідь — з уже прочитаних позицій і підключень та щойно створених запитів, у порядку пар
    // (позиція × підключення за пріоритетом); getBatch перечитав би все те саме ще раз.
    const connById = new Map(connections.map(c => [c.id, c]));
    const order = new Map(pairs.map((p, i) => [`${p.itemId}|${p.connectionId}`, i]));
    const pairIndex = (r: { purchaseListItemId: string | null; connectionId: string }) =>
      order.get(`${r.purchaseListItemId}|${r.connectionId}`) ?? 0;
    const requests: RequestRow[] = created
      .map(r => ({ ...r, connection: connById.get(r.connectionId) as RequestRow['connection'] }))
      .sort((a, b) => pairIndex(a) - pairIndex(b));
    const itemDtos = await this.buildItems(orgId, items, requests, opts.role);
    return {
      ...toBatchDto(batch, ids, itemDtos, requests),
      queueUnavailable,
      noConnections: connections.length === 0,
      skippedItemIds,
    };
  }

  /** Постановка пошуку в чергу; false — Redis недоступний (рядок лишається QUEUED для sweep). */
  async enqueueSearch(orgId: string, requestId: string): Promise<boolean> {
    return this.enqueueSearchMany(orgId, [requestId]);
  }

  /**
   * Пошуки batch-у — у чергу пачками `addBulk` (один обмін з Redis на пачку): по одній `add`
   * 100 позицій × 5 підключень тримали відповідь `search` ~300 мс лише на постановці.
   * false — Redis недоступний: рядки пачки лишаються QUEUED з причиною, їх підхопить sweep.
   */
  async enqueueSearchMany(orgId: string, requestIds: string[]): Promise<boolean> {
    let ok = true;
    for (let i = 0; i < requestIds.length; i += ENQUEUE_CHUNK) {
      const chunk = requestIds.slice(i, i + ENQUEUE_CHUNK);
      try {
        await this.searchQueue.addBulk(
          chunk.map(requestId => ({
            name: 'search',
            data: { orgId, requestId },
            opts: {
              attempts: 10,
              backoff: { type: 'exponential', delay: 30_000 },
              jobId: `supplier-search-${requestId}`,
              removeOnComplete: true,
              // Сталий jobId: failed-задача з тим самим id блокувала б перепостановку sweep-ом.
              removeOnFail: true,
            },
          })),
        );
      } catch (e) {
        ok = false;
        const message = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Пошуки (${chunk.length}) не поставлено в чергу: ${message}`);
        await this.prisma.supplierOfferRequest.updateMany({
          where: { id: { in: chunk }, orgId, status: 'QUEUED' },
          data: { enqueueError: message.slice(0, 300) },
        });
      }
    }
    return ok;
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
    return toBatchDto(batch, itemIds, itemDtos, requests);
  }

  /**
   * BR-SOFR-002: легкий стан batch-у для опитування UI — лише статуси запитів, без позицій і
   * пропозицій. Повний batch UI перечитує, коли запит перейшов у DONE / FAILED.
   */
  async getBatchStatus(orgId: string, batchId: string): Promise<SupplierOfferBatchStatusDto> {
    const [batch, requests] = await Promise.all([
      this.prisma.supplierOfferBatch.findFirst({
        where: { id: batchId, orgId, deletedAt: null },
        select: { id: true, completedAt: true },
      }),
      this.prisma.supplierOfferRequest.findMany({
        where: { orgId, batchId, deletedAt: null },
        select: { id: true, status: true, nextRetryAt: true, fromCache: true, error: true },
        orderBy: { createdAt: 'asc' },
        take: 5000,
      }),
    ]);
    if (!batch) throw new NotFoundException(err('err.supplierApi.batchNotFound'));
    return {
      id: batch.id,
      done: requests.every(r => isFinalStatus(r.status)),
      completedAt: batch.completedAt?.toISOString() ?? null,
      requests: requests.map(r => ({
        id: r.id,
        status: r.status,
        nextRetryAt: r.nextRetryAt?.toISOString() ?? null,
        fromCache: r.fromCache,
        error: r.error,
      })),
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
    if (!isItemOpen(item)) throw new BadRequestException(err('err.purchaseList.itemNotOpen'));
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

    // Кратність постачальника (BR-SOFR-006, як автопідбір BR-SOFR-007): кількість позиції —
    // до кратності вгору (`applyOfferData`), інакше в API піде некратна кількість (Bug #890).
    const write = async (targetGoodId: string | null) => {
      const res = await this.prisma.purchaseListItem.updateMany({
        where: {
          id: item.id,
          orgId,
          ...OPEN_ITEM_WHERE,
          quantity: item.quantity,
          goodId: item.goodId,
        },
        data: {
          ...applyOfferData(offer, {
            supplierId: offer.connection.counterpartyId,
            expectedPrice: priceUah,
            quantity: item.quantity,
            chosenBy: 'MANUAL',
          }),
          ...(targetGoodId && targetGoodId !== item.goodId ? goodSwap(item, targetGoodId) : {}),
        },
      });
      if (res.count !== 1) throw conflict();
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
    if (!isItemOpen(item)) throw new BadRequestException(err('err.purchaseList.itemNotOpen'));
    const res = await this.prisma.purchaseListItem.updateMany({
      where: {
        id: item.id,
        orgId,
        ...OPEN_ITEM_WHERE,
        quantity: item.quantity,
        offerKey: item.offerKey,
      },
      data: { ...CLEAR_OFFER_SNAPSHOT },
    });
    if (res.count !== 1) throw conflict();
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
    const byId = new Map(items.map(i => [i.id, i]));
    return ids.map(id => byId.get(id) as ItemForOffers);
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
    const byRequest = groupBy(offers, o => o.requestId);
    const requestsByItem = groupBy(requests, r => r.purchaseListItemId);
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
      const itemOpen = isItemOpen(item);
      const reqDtos: SupplierOfferRequestDto[] = [];
      for (const r of requestsByItem.get(item.id) ?? []) {
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

const isFinalStatus = (status: string): boolean => status === 'DONE' || status === 'FAILED';

function toBatchDto(
  batch: Pick<SupplierOfferBatch, 'id' | 'purpose' | 'strategy' | 'completedAt' | 'createdAt'>,
  itemIds: string[],
  itemDtos: SupplierOfferItemDto[],
  requests: Array<{ status: string }>,
): SupplierOfferBatchDto {
  const byItem = new Map(itemDtos.map(i => [i.itemId, i]));
  return {
    id: batch.id,
    purpose: batch.purpose,
    strategy: batch.strategy,
    done: requests.every(r => isFinalStatus(r.status)),
    completedAt: batch.completedAt?.toISOString() ?? null,
    createdAt: batch.createdAt.toISOString(),
    items: itemIds.map(id => byItem.get(id)).filter((i): i is SupplierOfferItemDto => !!i),
  };
}
