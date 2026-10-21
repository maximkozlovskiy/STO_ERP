import { createHash } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, PurchaseListItem, SupplierOffer } from '@prisma/client';
import {
  formatPersonName,
  TRANSACTION_TIMEOUT_MS,
  type SupplierOfferAllocateValues,
} from '@sto/shared';
import { PrismaService } from '../../../prisma/prisma.service';
import { err } from '../../../common/utils/err';
import { groupBy } from '../../../common/utils/array';
import { money, sumMoney } from '../../../common/utils/money';
import { SettingsService } from '../../settings/settings.service';
import { canSeeItemCost } from '../../purchase-lists/purchase-lists.mapper';
import { conflict, isItemOpen, OPEN_ITEM_WHERE } from '../../purchase-lists/purchase-lists.helpers';
import {
  goodSwap,
  itemPartData,
  offerSnapshot,
} from '../../purchase-lists/purchase-list-offer-snapshot';
import { SupplierPriceConverter } from '../offers/supplier-price-converter';
import { offerSelectability } from '../offers/offer-selectability';
import type {
  SupplierAllocationItemDto,
  SupplierAllocationResultDto,
} from '../offers/supplier-offers.dto';
import {
  ALLOCATION_EPSILON,
  allocateOffers,
  type AllocationOffer,
  type AllocationResult,
} from './offer-allocation';

interface ConnectionInfo {
  counterpartyId: string;
  priority: number;
  defaultDeliveryDays: number | null;
  supplierName: string;
}

interface ItemPlan {
  item: PurchaseListItem & { good: { name: string } };
  offers: Map<string, SupplierOffer>;
  connections: Map<string, ConnectionInfo>;
  result: AllocationResult;
  priceById: Map<string, number | null>;
  /** Товар, на який шукали пропозицію (власний запит позиції): після заміни аналогом це оригінал. */
  goodByOffer: Map<string, string>;
  skippedReason: 'itemNotOpen' | 'noOffers' | 'manualChoice' | null;
}

/**
 * Автопідбір пропозицій за стратегією (BR-SOFR-008, 009). Попередній перегляд (`dryRun`) і
 * застосування рахуються однаково: застосування перечитує позиції й пропозиції та пише все в
 * одній транзакції — кожна позиція CAS на стан, з якого рахувався розподіл (BR-PL-005); зміна
 * будь-якої → 409, нічого не записано. Одна частина — знімок на позицію; кілька — позиція
 * ділиться (знімок на кожну, BR-PL-017); непокрита решта — нова OPEN-позиція без пропозиції.
 *
 * Аналоги в автопідборі — лише коли `supplierAllowAnalogsInAuto`, позиція ручна й аналог уже є
 * в каталозі (matched): автопідбір не створює товарів.
 */
@Injectable()
export class SupplierAllocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly converter: SupplierPriceConverter,
  ) {}

  async allocate(
    orgId: string,
    dto: SupplierOfferAllocateValues,
    role?: string,
  ): Promise<SupplierAllocationResultDto> {
    const plans = await this.plan(orgId, dto);
    const previewToken = planToken(plans);
    // BR-SOFR-009: застосовується саме те, що користувач бачив у перегляді. Позиції, пропозиції чи
    // курс змінились між переглядом і «Застосувати» → 409, нічого не записано.
    if (!dto.dryRun && dto.previewToken && dto.previewToken !== previewToken) {
      throw new ConflictException(err('err.supplierApi.allocationChanged'));
    }
    if (!dto.dryRun) await this.apply(orgId, plans);
    return { ...this.toDto(dto, plans, role, !dto.dryRun), previewToken };
  }

  private async plan(orgId: string, dto: SupplierOfferAllocateValues): Promise<ItemPlan[]> {
    const batch = await this.prisma.supplierOfferBatch.findFirst({
      where: { id: dto.batchId, orgId, deletedAt: null },
      select: { itemIds: true },
    });
    if (!batch) throw new NotFoundException(err('err.supplierApi.batchNotFound'));
    const itemIds = Array.isArray(batch.itemIds) ? (batch.itemIds as string[]) : [];
    const s = await this.settings.getOrganisationSettings(orgId);
    const [items, requests] = await Promise.all([
      this.prisma.purchaseListItem.findMany({
        where: { orgId, id: { in: itemIds }, deletedAt: null },
        include: { good: { select: { name: true } } },
        take: itemIds.length || 1,
      }),
      this.prisma.supplierOfferRequest.findMany({
        where: { orgId, batchId: dto.batchId, status: 'DONE', deletedAt: null },
        select: { id: true, cacheOfId: true, purchaseListItemId: true, goodId: true },
        take: 5000,
      }),
    ]);
    // Джерельний запит (свій чи той, з якого взято кеш) → запити позицій batch-у.
    const own = requests.filter(r => r.purchaseListItemId);
    const sourceOf = (r: { id: string; cacheOfId: string | null }) => r.cacheOfId ?? r.id;
    const sourceToItem = groupBy(own, sourceOf);
    // (позиція, джерельний запит) → товар, на який шукали (власний запит позиції).
    const searchedGood = new Map<string, string>();
    for (const r of own)
      if (r.goodId) searchedGood.set(`${r.purchaseListItemId}|${sourceOf(r)}`, r.goodId);
    const offers = sourceToItem.size
      ? await this.prisma.supplierOffer.findMany({
          where: { orgId, requestId: { in: [...sourceToItem.keys()] }, deletedAt: null },
          take: 20_000,
        })
      : [];
    // Пропозиції позиції — за її запитами (одна пропозиція кешованого запиту — кільком позиціям).
    const offersByItem = new Map<string, SupplierOffer[]>();
    for (const o of offers) {
      for (const r of sourceToItem.get(o.requestId) ?? []) {
        const itemId = r.purchaseListItemId as string;
        const list = offersByItem.get(itemId);
        if (list) {
          if (list[list.length - 1] !== o) list.push(o);
        } else offersByItem.set(itemId, [o]);
      }
    }
    const itemById = new Map(items.map(i => [i.id, i]));
    const connections = await this.connections(orgId, [
      ...new Set(offers.map(o => o.connectionId)),
    ]);
    const toUah = this.converter.forOrg(orgId);
    const now = new Date();

    // Одна пропозиція (спільний кешований запит) може дістатися кільком позиціям batch-у: наявне
    // ділиться між ними в порядку позицій, а не віддається кожній повністю (BR-SOFR-008).
    const left = new Map<string, number>();
    const plans: ItemPlan[] = [];
    for (const id of itemIds) {
      const item = itemById.get(id);
      if (!item) continue;
      const itemOffers = offersByItem.get(item.id) ?? [];
      const offerById = new Map(itemOffers.map(o => [o.id, o]));
      const open = isItemOpen(item);
      // Ручний вибір користувача автопідбір не перезаписує, доки цього не попросили (BR-SOFR-009).
      const keepManual = open && item.offerChosenBy === 'MANUAL' && !dto.overrideManual;
      const priceById = new Map<string, number | null>();
      const goodByOffer = new Map<string, string>();
      const input: AllocationOffer[] = [];
      for (const o of itemOffers) {
        const c = connections.get(o.connectionId);
        if (!c) continue; // підключення вимкнене чи видалене
        const searched = searchedGood.get(`${item.id}|${o.requestId}`);
        if (searched) goodByOffer.set(o.id, searched);
        const available = left.get(o.id) ?? o.qty;
        if (available <= ALLOCATION_EPSILON) continue; // уже розподілено іншим позиціям
        const priceUah = await toUah(o.currencyCode, Number(o.price));
        priceById.set(o.id, priceUah);
        const sel = offerSelectability({
          isAnalog: o.isAnalog,
          matchStatus: o.matchStatus,
          matchedGoodId: o.matchedGoodId,
          itemSource: item.source,
          itemOpen: open,
          policy: s.supplierAnalogPolicy,
          priceUah,
        });
        const analogOk =
          !o.isAnalog ||
          (s.supplierAllowAnalogsInAuto && o.matchStatus === 'matched' && !!o.matchedGoodId);
        input.push({
          id: o.id,
          supplierId: c.counterpartyId,
          connectionPriority: c.priority,
          offerKey: o.offerKey,
          priceUah,
          qty: available,
          qtyIsLowerBound: o.qtyIsLowerBound,
          multiplicity: o.multiplicity,
          deliveryDays: o.deliveryDays,
          deliveryDate: o.deliveryDate,
          connectionDefaultDays: c.defaultDeliveryDays,
          selectable: sel.selectable && analogOk,
        });
      }
      const result =
        open && !keepManual
          ? allocateOffers(item.quantity, input, {
              strategy: dto.strategy,
              priceWeight: s.supplierOptimalPriceWeight,
              allowSplit: s.supplierAllowSplit,
              unknownDeliveryDays: s.supplierUnknownDeliveryDays,
              now,
            })
          : { parts: [], uncovered: 0 };
      for (const part of result.parts) {
        const base = left.get(part.offerId) ?? offerById.get(part.offerId)?.qty ?? 0;
        left.set(part.offerId, Math.max(0, base - part.qty));
      }
      plans.push({
        item,
        offers: offerById,
        connections,
        result,
        priceById,
        goodByOffer,
        skippedReason: !open
          ? 'itemNotOpen'
          : keepManual
            ? 'manualChoice'
            : result.parts.length === 0
              ? 'noOffers'
              : null,
      });
    }
    return plans;
  }

  /** BR-SOFR-009: одна транзакція; кожна позиція — CAS на прочитаний стан. */
  private async apply(orgId: string, plans: ItemPlan[]): Promise<void> {
    await this.prisma.$transaction(
      async tx => {
        for (const p of plans) {
          if (p.result.parts.length === 0) continue;
          await this.applyItem(tx, orgId, p);
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  private async applyItem(tx: Prisma.TransactionClient, orgId: string, p: ItemPlan): Promise<void> {
    const { item, result } = p;
    const dataFor = (offerId: string) => {
      const o = p.offers.get(offerId) as SupplierOffer;
      // Товар частини: аналог — його товар із каталогу; не аналог — товар, на який шукали
      // (після попередньої заміни аналогом це оригінал позиції — повертаємо його).
      const target = o.isAnalog ? o.matchedGoodId : (p.goodByOffer.get(offerId) ?? null);
      return {
        expectedPrice: p.priceById.get(offerId) ?? null,
        ...offerSnapshot(o, 'AUTO'),
        ...(target && target !== item.goodId ? goodSwap(item, target) : {}),
      };
    };
    const supplierOf = (offerId: string) =>
      (p.connections.get((p.offers.get(offerId) as SupplierOffer).connectionId) as ConnectionInfo)
        .counterpartyId;

    const [first, ...rest] = result.parts;
    const res = await tx.purchaseListItem.updateMany({
      where: {
        id: item.id,
        orgId,
        ...OPEN_ITEM_WHERE,
        quantity: item.quantity,
        goodId: item.goodId,
        offerKey: item.offerKey,
      },
      data: {
        ...dataFor(first.offerId),
        supplierId: supplierOf(first.offerId),
        quantity: first.qty,
      },
    });
    if (res.count !== 1) throw conflict();
    for (const part of rest) {
      await tx.purchaseListItem.create({
        data: {
          ...itemPartData(item, part.qty, { status: 'OPEN', snapshot: 'none' }),
          ...dataFor(part.offerId),
          supplierId: supplierOf(part.offerId),
        },
      });
    }
    if (result.uncovered > ALLOCATION_EPSILON) {
      // Непокрита решта — без пропозиції й без постачальника пропозиції (BR-SOFR-008).
      await tx.purchaseListItem.create({
        data: itemPartData(item, result.uncovered, { status: 'OPEN', snapshot: 'none' }),
      });
    }
  }

  private async connections(orgId: string, ids: string[]): Promise<Map<string, ConnectionInfo>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.supplierConnection.findMany({
      where: { orgId, id: { in: ids }, enabled: true, deletedAt: null },
      select: {
        id: true,
        counterpartyId: true,
        priority: true,
        defaultDeliveryDays: true,
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
      },
      take: ids.length,
    });
    const map = new Map<string, ConnectionInfo>();
    for (const r of rows) {
      map.set(r.id, {
        counterpartyId: r.counterpartyId,
        priority: r.priority,
        defaultDeliveryDays: r.defaultDeliveryDays,
        supplierName: formatPersonName(
          r.counterparty.lastName,
          r.counterparty.firstName,
          r.counterparty.companyName,
        ),
      });
    }
    return map;
  }

  private toDto(
    dto: SupplierOfferAllocateValues,
    plans: ItemPlan[],
    role: string | undefined,
    applied: boolean,
  ): Omit<SupplierAllocationResultDto, 'previewToken'> {
    const showPrices = canSeeItemCost(role);
    const items: SupplierAllocationItemDto[] = plans.map(p => ({
      itemId: p.item.id,
      goodName: p.item.good.name,
      need: p.item.quantity,
      uncovered: p.result.uncovered,
      skippedReason: p.skippedReason,
      parts: p.result.parts.map(part => {
        const o = p.offers.get(part.offerId) as SupplierOffer;
        const c = p.connections.get(o.connectionId);
        return {
          offerId: o.id,
          connectionId: o.connectionId,
          supplierId: c?.counterpartyId ?? '',
          supplierName: c?.supplierName ?? '',
          warehouseName: o.warehouseName,
          offerKey: o.offerKey,
          qty: part.qty,
          priceUah: showPrices ? part.priceUah : null,
          days: part.days,
          isAnalog: o.isAnalog,
        };
      }),
    }));
    const total = sumMoney(
      plans.flatMap(p => p.result.parts.map(part => money(part.priceUah * part.qty))),
    );
    return { strategy: dto.strategy, applied, items, totalUah: showPrices ? total : null };
  }
}

/** Відбиток розподілу: що саме буде записано (позиції, частини, ціни) — для BR-SOFR-009. */
function planToken(plans: ItemPlan[]): string {
  const shape = plans.map(p => [
    p.item.id,
    p.item.quantity,
    p.item.goodId,
    p.item.offerKey,
    p.skippedReason,
    p.result.uncovered,
    p.result.parts.map(x => [x.offerId, x.qty, x.priceUah]),
  ]);
  return createHash('sha1').update(JSON.stringify(shape)).digest('hex');
}
