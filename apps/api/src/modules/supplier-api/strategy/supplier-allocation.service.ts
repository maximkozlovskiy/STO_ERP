import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, PurchaseListItem, SupplierOffer } from '@prisma/client';
import {
  formatPersonName,
  TRANSACTION_TIMEOUT_MS,
  translateError,
  type SupplierOfferAllocateValues,
} from '@sto/shared';
import { PrismaService } from '../../../prisma/prisma.service';
import { getLocale } from '../../../common/tenant/tenant-context';
import { money, sumMoney } from '../../../common/utils/money';
import { SettingsService } from '../../settings/settings.service';
import { canSeeItemCost } from '../../purchase-lists/purchase-lists.mapper';
import { itemPartData } from '../../purchase-lists/purchase-list-offer-snapshot';
import { SupplierPriceConverter } from '../offers/supplier-price-converter';
import { offerSelectability } from '../offers/offer-selectability';
import { snapshotOf } from '../offers/supplier-offers.service';
import type {
  SupplierAllocationItemDto,
  SupplierAllocationResultDto,
} from '../offers/supplier-offers.dto';
import { allocateOffers, type AllocationOffer, type AllocationResult } from './offer-allocation';

const err = (key: string, params?: Record<string, string | number>) =>
  translateError(key, getLocale(), params);

const OPEN_ITEM = { status: 'OPEN' as const, purchaseOrderId: null, deletedAt: null };

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
    if (!dto.dryRun) await this.apply(orgId, plans);
    return this.toDto(dto, plans, role, !dto.dryRun);
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
        select: { id: true, cacheOfId: true, purchaseListItemId: true },
        take: 5000,
      }),
    ]);
    const sourceToItem = new Map<string, string[]>();
    for (const r of requests) {
      if (!r.purchaseListItemId) continue;
      const src = r.cacheOfId ?? r.id;
      sourceToItem.set(src, [...(sourceToItem.get(src) ?? []), r.purchaseListItemId]);
    }
    const offers = sourceToItem.size
      ? await this.prisma.supplierOffer.findMany({
          where: { orgId, requestId: { in: [...sourceToItem.keys()] }, deletedAt: null },
          take: 20_000,
        })
      : [];
    const connections = await this.connections(orgId, [
      ...new Set(offers.map(o => o.connectionId)),
    ]);
    const toUah = this.converter.forOrg(orgId);
    const now = new Date();

    const plans: ItemPlan[] = [];
    for (const id of itemIds) {
      const item = items.find(i => i.id === id);
      if (!item) continue;
      const own = offers.filter(o => (sourceToItem.get(o.requestId) ?? []).includes(item.id));
      const open = item.status === 'OPEN' && item.purchaseOrderId === null;
      // Ручний вибір користувача автопідбір не перезаписує, доки цього не попросили (BR-SOFR-009).
      const keepManual = open && item.offerChosenBy === 'MANUAL' && !dto.overrideManual;
      const priceById = new Map<string, number | null>();
      const input: AllocationOffer[] = [];
      for (const o of own) {
        const c = connections.get(o.connectionId);
        if (!c) continue; // підключення вимкнене чи видалене
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
          qty: o.qty,
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
      plans.push({
        item,
        offers: new Map(own.map(o => [o.id, o])),
        connections,
        result,
        priceById,
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
      const analogGood =
        o.isAnalog && o.matchedGoodId && o.matchedGoodId !== item.goodId ? o.matchedGoodId : null;
      return {
        expectedPrice: p.priceById.get(offerId) ?? null,
        ...snapshotOf(o, 'AUTO'),
        ...(analogGood
          ? { goodId: analogGood, originalGoodId: item.originalGoodId ?? item.goodId }
          : {}),
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
        ...OPEN_ITEM,
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
    if (res.count !== 1) throw new ConflictException(err('err.purchaseList.concurrentChange'));
    for (const part of rest) {
      await tx.purchaseListItem.create({
        data: {
          ...itemPartData(item, part.qty, { status: 'OPEN', snapshot: 'none' }),
          ...dataFor(part.offerId),
          supplierId: supplierOf(part.offerId),
        },
      });
    }
    if (result.uncovered > 1e-9) {
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
  ): SupplierAllocationResultDto {
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
