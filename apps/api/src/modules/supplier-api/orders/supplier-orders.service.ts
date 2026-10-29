import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { OnEvent } from '@nestjs/event-emitter';
import type { Queue } from 'bullmq';
import type { Prisma, PurchaseListItem } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../../prisma/prisma.service';
import { runWithTenant } from '../../../common/tenant/tenant-context';
import { err } from '../../../common/utils/err';
import { groupBy } from '../../../common/utils/array';
import { SettingsService } from '../../settings/settings.service';
import { PurchaseOrdersService } from '../../purchase-orders/purchase-orders.service';
import {
  PurchaseListLinkService,
  undelivered,
} from '../../purchase-lists/purchase-list-link.service';
import {
  lockWorkOrdersForUpdate,
  QTY_EPSILON,
} from '../../work-orders/work-order-stock-requirements';
import { SupplierAdapterRegistry } from '../adapters/supplier-adapter-registry';
import { parseOptions } from '../connections/supplier-connection-context';
import {
  SUPPLIER_ORDER_QUEUED_EVENT,
  type SupplierOrderQueuedEvent,
} from '../outbox/supplier-order-outbox.service';
import {
  planSupplierOrders,
  summarizeSupplierApiStatus,
  type PlannedOrder,
  type PlanConnection,
} from './supplier-order-planner';
import type {
  PurchaseOrderSupplierApiDto,
  SupplierApiOrderDto,
  SupplierApiReleaseResultDto,
} from './supplier-orders.dto';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

/** Статуси замовлення, з яких його ще можна відправити в API. */
const SENDABLE_PO = new Set(['DRAFT', 'ORDERED']);

/** Задача відправки: сталий jobId дедуплікує живу (кнопка ‖ sweep), див. `enqueuePlace`. */
const placeJob = (orgId: string, purchaseOrderId: string) => ({
  name: 'place',
  data: { orgId, purchaseOrderId },
  opts: {
    attempts: 10,
    backoff: { type: 'exponential', delay: 30_000 },
    jobId: `supplier-place-${purchaseOrderId}`,
    removeOnComplete: true,
    removeOnFail: true,
  },
});

const PO_SELECT = {
  id: true,
  number: true,
  status: true,
  supplierId: true,
  warehouseId: true,
  supplierApiStatus: true,
  supplierApiSentAt: true,
  supplierApiError: true,
  warehouse: { select: { name: true } },
} as const satisfies Prisma.PurchaseOrderSelect;
type LoadedPo = Prisma.PurchaseOrderGetPayload<{ select: typeof PO_SELECT }>;

const ORDER_INCLUDE = {
  connection: { select: { name: true, provider: true } },
  lines: {
    where: { deletedAt: null },
    include: { good: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
    take: 1000,
  },
} as const satisfies Prisma.SupplierOrderInclude;

/**
 * Передача замовлення постачальнику через API (BR-PO-011, BR-SCON-009…014): кнопка «Відправити
 * в API», стан для картки замовлення, «Оновити статус», «Повернути непідтверджене», планування
 * (спільне з обробником для outbox-шляху) і підсумок `supplierApiStatus`.
 */
@Injectable()
export class SupplierOrdersService {
  private readonly logger = new Logger(SupplierOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly registry: SupplierAdapterRegistry,
    private readonly purchaseOrders: PurchaseOrdersService,
    private readonly links: PurchaseListLinkService,
    @InjectQueue('supplier-order') private readonly orderQueue: Queue,
  ) {}

  /**
   * BR-SCON-009: «Відправити в API». План перевіряється ДО переходу статусу (помилка — 400 без
   * змін); з «Чернетки» замовлення спершу переходить у «Замовлено» звичайним FSM.
   */
  async send(
    orgId: string,
    purchaseOrderId: string,
    role?: string,
    actorId?: string,
  ): Promise<PurchaseOrderSupplierApiDto> {
    const po = await this.loadPo(this.prisma, orgId, purchaseOrderId);
    if (!SENDABLE_PO.has(po.status))
      throw new BadRequestException(err('err.supplierApi.orderClosed'));
    if (po.supplierApiStatus === 'QUEUED') return this.getState(orgId, purchaseOrderId, role);
    if (po.supplierApiStatus !== 'NOT_SENT' && po.supplierApiStatus !== 'FAILED') {
      throw new BadRequestException(err('err.supplierApi.alreadySent'));
    }
    const hasActive = await this.prisma.supplierOrder.count({
      where: { orgId, purchaseOrderId, deletedAt: null, status: { not: 'CANCELLED' } },
    });
    const plan =
      hasActive > 0 ? null : await this.buildPlan(this.prisma, orgId, purchaseOrderId, po);
    if (po.status === 'DRAFT') {
      // Автор події DRAFT → ORDERED — працівник, що натиснув «Відправити» (Bug #996, BR-AUT-023).
      await this.purchaseOrders.transition(orgId, purchaseOrderId, 'ORDERED', { actorId });
    }
    await this.prisma.$transaction(
      async tx => {
        await this.lockPo(tx, orgId, purchaseOrderId);
        await this.ensurePlannedInTx(tx, orgId, purchaseOrderId, plan, po);
        await tx.purchaseOrder.updateMany({
          where: {
            id: purchaseOrderId,
            orgId,
            deletedAt: null,
            supplierApiStatus: { in: ['NOT_SENT', 'FAILED', 'QUEUED'] },
          },
          data: { supplierApiStatus: 'QUEUED', supplierApiError: null },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    await this.enqueuePlace(orgId, purchaseOrderId);
    return this.getState(orgId, purchaseOrderId, role);
  }

  /** Outbox (режим ON_ORDERED): після коміту переходу — задача відправки. */
  @OnEvent(SUPPLIER_ORDER_QUEUED_EVENT)
  async onQueued(evt: SupplierOrderQueuedEvent): Promise<void> {
    await runWithTenant({ orgId: evt.orgId }, () =>
      this.enqueuePlace(evt.orgId, evt.purchaseOrderId),
    );
  }

  /**
   * Задача відправки; Redis недоступний — замовлення лишається QUEUED, його підхопить sweep.
   * Сталий jobId дедуплікує живу задачу (кнопка ‖ sweep), а `removeOnFail: true` — щоб після
   * остаточного падіння повторна відправка не губилась: BullMQ мовчки не додає задачу з jobId,
   * що лежить у failed. Падіння фіксує DLQ (`onFailed` бачить Job у пам'яті), у job.data лише id.
   */
  async enqueuePlace(orgId: string, purchaseOrderId: string): Promise<boolean> {
    try {
      const { name, data, opts } = placeJob(orgId, purchaseOrderId);
      await this.orderQueue.add(name, data, opts);
      return true;
    } catch (e) {
      this.logger.warn(
        `Відправку ${purchaseOrderId} не поставлено в чергу: ${e instanceof Error ? e.message : e}`,
      );
      return false;
    }
  }

  /** Відправки кількох замовлень одним `addBulk` (sweep); false — Redis недоступний. */
  async enqueuePlaceMany(orgId: string, purchaseOrderIds: string[]): Promise<boolean> {
    if (purchaseOrderIds.length === 0) return true;
    try {
      await this.orderQueue.addBulk(purchaseOrderIds.map(id => placeJob(orgId, id)));
      return true;
    } catch (e) {
      this.logger.warn(
        `Відправки (${purchaseOrderIds.length}) не поставлено в чергу: ${e instanceof Error ? e.message : e}`,
      );
      return false;
    }
  }

  /**
   * «Оновити статус» — задача опитування цього замовлення. Сталий jobId: повторні натискання,
   * поки задача жива, не множать опитування; `removeOnFail: true` — щоб упала не блокувала наступну.
   */
  async requestPoll(
    orgId: string,
    purchaseOrderId: string,
    role?: string,
  ): Promise<PurchaseOrderSupplierApiDto> {
    await this.loadPo(this.prisma, orgId, purchaseOrderId);
    try {
      await this.orderQueue.add(
        'poll-now',
        { orgId, purchaseOrderId },
        {
          attempts: 10,
          backoff: { type: 'exponential', delay: 30_000 },
          jobId: `supplier-poll-now-${purchaseOrderId}`,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (e) {
      this.logger.warn(
        `Опитування ${purchaseOrderId} не поставлено в чергу: ${e instanceof Error ? e.message : e}`,
      );
    }
    return this.getState(orgId, purchaseOrderId, role);
  }

  /**
   * План відправки (BR-SCON-010) з позицій списку цього замовлення; помилка — 400 з ключем
   * (`lineWithoutOffer`, `ambiguousOffer`, `offerFromOtherConnection`, `connectionDisabled`,
   * `noWarehouseMapping`, `noApiLines`).
   */
  async buildPlan(
    db: Db,
    orgId: string,
    purchaseOrderId: string,
    loaded?: LoadedPo,
  ): Promise<PlannedOrder[]> {
    const po = loaded ?? (await this.loadPo(db, orgId, purchaseOrderId));
    const [lines, items, connections] = await Promise.all([
      db.purchaseOrderLine.findMany({
        where: { orgId, purchaseOrderId, deletedAt: null },
        select: { goodId: true, quantity: true, good: { select: { name: true } } },
        take: 1000,
      }),
      db.purchaseListItem.findMany({
        where: { orgId, purchaseOrderId, status: 'ORDERED', deletedAt: null },
        include: { good: { select: { name: true } } },
        take: 1000,
      }),
      db.supplierConnection.findMany({
        where: { orgId, deletedAt: null },
        select: { id: true, counterpartyId: true, enabled: true, provider: true, options: true },
        take: 200,
      }),
    ]);
    const conns = new Map<string, PlanConnection>();
    for (const c of connections) {
      conns.set(c.id, {
        id: c.id,
        counterpartyId: c.counterpartyId,
        enabled: c.enabled,
        capabilities: this.registry.get(c.provider).capabilities,
        options: parseOptions(c.options),
      });
    }
    const res = planSupplierOrders({
      po: {
        supplierId: po.supplierId,
        warehouseId: po.warehouseId,
        warehouseName: po.warehouse.name,
      },
      lines: lines.map(l => ({ goodId: l.goodId, goodName: l.good.name, quantity: l.quantity })),
      items: items.map(i => ({
        goodId: i.goodId,
        goodName: i.good.name,
        quantity: i.quantity,
        offerConnectionId: i.offerConnectionId,
        offerKey: i.offerKey,
        offerSupplierItemId: i.offerSupplierItemId,
        offerWarehouseCode: i.offerWarehouseCode,
        offerPrice: i.offerPrice === null ? null : Number(i.offerPrice),
        offerCurrencyCode: i.offerCurrencyCode,
      })),
      connections: conns,
    });
    if (!res.ok)
      throw new BadRequestException(err(res.key, 'params' in res ? res.params : undefined));
    return res.orders;
  }

  /**
   * Заморожений план (SupplierOrder + рядки) — один раз на замовлення. Повторна відправка після
   * FAILED продовжує ті самі зовнішні замовлення з записаного кроку. Викликати під `lockPo`:
   * кнопка й обробник outbox-шляху не створять план двічі.
   */
  async ensurePlannedInTx(
    tx: Tx,
    orgId: string,
    purchaseOrderId: string,
    plan: PlannedOrder[] | null,
    loaded?: Pick<LoadedPo, 'number'>,
  ): Promise<void> {
    const existing = await tx.supplierOrder.findMany({
      where: { orgId, purchaseOrderId, deletedAt: null },
      select: { id: true, status: true },
      take: 100,
    });
    if (existing.some(o => o.status !== 'CANCELLED')) {
      await tx.supplierOrder.updateMany({
        where: { orgId, purchaseOrderId, deletedAt: null, status: 'FAILED' },
        data: { status: 'QUEUED', error: null },
      });
      return;
    }
    const orders = plan ?? (await this.buildPlan(tx, orgId, purchaseOrderId));
    const po = loaded ?? (await this.loadPo(tx, orgId, purchaseOrderId));
    for (const [i, o] of orders.entries()) {
      // Номер замовлення не глобально унікальний (нумерацію можна скинути) — reference, ключ звірки
      // в кабінеті постачальника, доповнено початком id зовнішнього замовлення.
      const id = randomUUID();
      const created = await tx.supplierOrder.create({
        data: {
          id,
          orgId,
          purchaseOrderId,
          connectionId: o.connectionId,
          supplierWarehouseCode: o.supplierWarehouseCode,
          status: 'QUEUED',
          reference: `STO-${po.number}-${existing.length + i + 1}-${id.slice(0, 8)}`,
        },
        select: { id: true },
      });
      await tx.supplierOrderLine.createMany({
        data: o.lines.map(l => ({
          orgId,
          supplierOrderId: created.id,
          goodId: l.goodId,
          offerKey: l.offerKey,
          supplierItemId: l.supplierItemId,
          warehouseCode: l.warehouseCode,
          qtyRequested: l.qtyRequested,
          priceRequested: l.priceRequested,
          currencyCode: l.currencyCode,
        })),
      });
    }
  }

  /** Підсумок на замовленні за його зовнішніми замовленнями (BR-SCON-013). */
  async refreshSummary(
    orgId: string,
    purchaseOrderId: string,
    error?: string | null,
  ): Promise<void> {
    const orders = await this.prisma.supplierOrder.findMany({
      where: { orgId, purchaseOrderId, deletedAt: null },
      select: {
        status: true,
        sentAt: true,
        error: true,
        lines: {
          where: { deletedAt: null },
          select: { qtyRequested: true, qtyConfirmed: true },
          take: 1000,
        },
      },
      take: 100,
    });
    const status = summarizeSupplierApiStatus(orders);
    const sentAt = orders
      .map(o => o.sentAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const firstError =
      error ??
      orders.find(o => o.error && (o.status === 'FAILED' || o.status === 'UNKNOWN'))?.error ??
      null;
    await this.prisma.purchaseOrder.updateMany({
      where: { id: purchaseOrderId, orgId },
      data: {
        supplierApiStatus: status,
        supplierApiSentAt: sentAt ?? null,
        supplierApiError: status === 'FAILED' || status === 'NEEDS_ATTENTION' ? firstError : null,
      },
    });
  }

  /** Замовлення без плану не відправилось (outbox-шлях): FAILED з причиною. */
  async markPlanFailed(orgId: string, purchaseOrderId: string, message: string): Promise<void> {
    await this.prisma.purchaseOrder.updateMany({
      where: { id: purchaseOrderId, orgId },
      data: { supplierApiStatus: 'FAILED', supplierApiError: message.slice(0, 500) },
    });
  }

  /**
   * BR-SCON-013: «Повернути непідтверджене в список» — по кожній пропозиції, на яку постачальник
   * відповів, ORDERED-позиції понад підтверджене повертаються в OPEN без пропозиції.
   */
  async releaseUnconfirmed(
    orgId: string,
    purchaseOrderId: string,
    role?: string,
  ): Promise<SupplierApiReleaseResultDto> {
    await this.loadPo(this.prisma, orgId, purchaseOrderId);
    const released = await this.prisma.$transaction(
      async tx => {
        // Наряди позицій блокуються ДО читання й зміни позицій (за id) — той самий порядок, що в
        // прийманні й переходах наряду: повернене звіряється з потребою наряду нижче (Bug #912).
        const woRows = await tx.purchaseListItem.findMany({
          where: { orgId, purchaseOrderId, status: 'ORDERED', deletedAt: null },
          select: { workOrderId: true },
          take: 1000,
        });
        await lockWorkOrdersForUpdate(
          tx,
          orgId,
          woRows.map(r => r.workOrderId).filter((id): id is string => id !== null),
        );
        // Стан нарядів під блокуванням — один запит на всі позиції, а не на кожну (sto-optimize).
        const [activeWo, excess] = await Promise.all([
          this.links.activeWorkOrderIds(tx, orgId, woRows),
          this.unconfirmed(tx, orgId, purchaseOrderId),
        ]);
        let total = 0;
        const touchedWo = new Set<string>();
        for (const { items, qty } of excess.values()) {
          let rest = qty;
          for (const item of items) {
            if (rest <= QTY_EPSILON) break;
            const cut = Math.min(rest, undelivered(item));
            if (cut <= QTY_EPSILON) continue;
            await this.links.releaseFromOrder(tx, orgId, item, cut, activeWo);
            if (item.workOrderId && activeWo.has(item.workOrderId)) touchedWo.add(item.workOrderId);
            rest -= cut;
            total += cut;
          }
        }
        if (total <= QTY_EPSILON)
          throw new BadRequestException(err('err.supplierApi.nothingToRelease'));
        // Повернене в OPEN не покриває більше, ніж наряду ще треба: потребу могли зменшити, поки
        // замовлення було в постачальника (ORDERED тоді не урізаються, BR-PL-013). Лише живі
        // наряди, як `PurchaseListLinkService.onOrderClosed`: у закритого повернене вже «Скасовано», а резерв
        // завершеного списано, не знято — `reservedQty` його позицій лишається (BR-PL-013).
        for (const woId of touchedWo) await this.links.onWorkOrderPartsChanged(tx, orgId, woId);
        return total;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return { released, state: await this.getState(orgId, purchaseOrderId, role) };
  }

  /** Непідтверджене за (товар, пропозиція): ORDERED-позиції понад підтверджене постачальником. */
  private async unconfirmed(db: Db, orgId: string, purchaseOrderId: string) {
    const [orders, items] = await Promise.all([
      db.supplierOrder.findMany({
        where: { orgId, purchaseOrderId, deletedAt: null },
        select: {
          status: true,
          lines: {
            where: { deletedAt: null },
            select: { goodId: true, offerKey: true, qtyConfirmed: true },
            take: 1000,
          },
        },
        take: 100,
      }),
      db.purchaseListItem.findMany({
        where: {
          orgId,
          purchaseOrderId,
          status: 'ORDERED',
          deletedAt: null,
          NOT: { offerKey: null },
        },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
    ]);
    return unconfirmedFrom(orders, items);
  }

  /** Стан передачі для картки замовлення (BR-PO-011). */
  async getState(
    orgId: string,
    purchaseOrderId: string,
    _role?: string,
  ): Promise<PurchaseOrderSupplierApiDto> {
    // Одним паралельним кроком: підключення постачальника — з увімкнених підключень організації
    // (їх одиниці), непідтверджене — з уже прочитаних зовнішніх замовлень і позицій.
    const [po, orders, s, enabledConnections, offerItems] = await Promise.all([
      this.loadPo(this.prisma, orgId, purchaseOrderId),
      this.prisma.supplierOrder.findMany({
        where: { orgId, purchaseOrderId, deletedAt: null },
        include: ORDER_INCLUDE,
        orderBy: { createdAt: 'asc' },
        take: 100,
      }),
      this.settings.getOrganisationSettings(orgId),
      // Постачальники з увімкненим підключенням, без обрізання: `take` відкидав би постачальника
      // замовлення, коли підключень багато (review 2026-10-21). `distinct` Prisma знімає дублі в пам'яті —
      // SQL читає всі увімкнені підключення організації; їх одиниці (partial-unique на постачальника й
      // провайдера), а фільтр за `po.supplierId` додав би RTT (зв'язку з контрагентом у моделі немає).
      this.prisma.supplierConnection.findMany({
        where: { orgId, enabled: true, deletedAt: null },
        select: { counterpartyId: true },
        distinct: ['counterpartyId'],
      }),
      // ORDERED-позиції з пропозицією: знімок (offeredAt) — для попередження про застарілі,
      // offerKey — для непідтвердженого.
      this.prisma.purchaseListItem.findMany({
        where: {
          orgId,
          purchaseOrderId,
          status: 'ORDERED',
          deletedAt: null,
          OR: [{ NOT: { offeredAt: null } }, { NOT: { offerKey: null } }],
        },
        include: { good: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
    ]);
    const hasConnection = enabledConnections.some(c => c.counterpartyId === po.supplierId);
    const excess = unconfirmedFrom(
      orders,
      offerItems.filter(i => i.offerKey !== null),
    );
    const ttlMs = s.supplierOfferTtlMinutes * 60_000;
    const stale = [
      ...new Set(
        offerItems
          .filter(i => i.offeredAt && Date.now() - i.offeredAt.getTime() > ttlMs)
          .map(i => i.good.name),
      ),
    ];
    const notSent = po.supplierApiStatus === 'NOT_SENT' || po.supplierApiStatus === 'FAILED';
    return {
      purchaseOrderId,
      supplierApiStatus: po.supplierApiStatus,
      supplierApiSentAt: po.supplierApiSentAt?.toISOString() ?? null,
      supplierApiError: po.supplierApiError,
      sendMode: s.supplierOrderSendMode,
      hasConnection,
      canSend: SENDABLE_PO.has(po.status) && notSent && hasConnection,
      canRelease: excess.size > 0,
      warnings:
        notSent && stale.length > 0
          ? [`${err('err.supplierApi.offerStale')}: ${stale.join(', ')}`]
          : [],
      orders: orders.map(o => this.orderDto(o)),
    };
  }

  private orderDto(
    o: Prisma.SupplierOrderGetPayload<{ include: typeof ORDER_INCLUDE }>,
  ): SupplierApiOrderDto {
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      id: o.id,
      connectionId: o.connectionId,
      connectionName: o.connection.name ?? o.connection.provider,
      provider: o.connection.provider,
      supplierWarehouseCode: o.supplierWarehouseCode,
      status: o.status,
      step: o.step,
      externalOrderId: o.externalOrderId,
      externalNumber: o.externalNumber,
      externalStatusRaw: o.externalStatusRaw,
      reference: o.reference,
      sentAt: iso(o.sentAt),
      confirmedAt: iso(o.confirmedAt),
      lastPolledAt: iso(o.lastPolledAt),
      nextPollAt: iso(o.nextPollAt),
      error: o.error,
      lines: o.lines.map(l => ({
        id: l.id,
        goodId: l.goodId,
        goodName: l.good.name,
        offerKey: l.offerKey,
        warehouseCode: l.warehouseCode,
        qtyRequested: l.qtyRequested,
        qtyConfirmed: l.qtyConfirmed,
        priceRequested: Number(l.priceRequested),
        priceConfirmed: l.priceConfirmed === null ? null : Number(l.priceConfirmed),
        currencyCode: l.currencyCode,
        statusRaw: l.statusRaw,
      })),
    };
  }

  /** Блокування рядка замовлення: план створюється рівно один раз (кнопка ‖ обробник). */
  async lockPo(tx: Tx, orgId: string, purchaseOrderId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${purchaseOrderId}::uuid AND "orgId" = ${orgId}::uuid FOR UPDATE`;
  }

  private async loadPo(db: Db, orgId: string, id: string): Promise<LoadedPo> {
    const po = await db.purchaseOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      select: PO_SELECT,
    });
    if (!po) throw new NotFoundException(err('err.purchaseOrder.notFound'));
    return po;
  }
}

/**
 * Непідтверджене за (товар, пропозиція) з уже прочитаних зовнішніх замовлень і ORDERED-позицій із
 * пропозицією (новіші — першими): позиції понад підтверджене постачальником.
 */
function unconfirmedFrom<T extends PurchaseListItem>(
  orders: Array<{
    status: string;
    lines: Array<{ goodId: string; offerKey: string; qtyConfirmed: number | null }>;
  }>,
  items: T[],
): Map<string, { items: T[]; qty: number }> {
  const confirmed = new Map<string, number>();
  for (const o of orders) {
    const refused = o.status === 'REJECTED' || o.status === 'CANCELLED';
    for (const l of o.lines) {
      if (l.qtyConfirmed === null && !refused) continue; // постачальник ще не відповів
      const key = `${l.goodId}|${l.offerKey}`;
      confirmed.set(key, (confirmed.get(key) ?? 0) + (l.qtyConfirmed ?? 0));
    }
  }
  const byKey = groupBy(items, i => `${i.goodId}|${i.offerKey}`);
  const out = new Map<string, { items: T[]; qty: number }>();
  for (const [key, conf] of confirmed) {
    const group = byKey.get(key) ?? [];
    const qty = group.reduce((s, i) => s + undelivered(i), 0) - conf;
    if (qty > QTY_EPSILON) out.set(key, { items: group, qty });
  }
  return out;
}
