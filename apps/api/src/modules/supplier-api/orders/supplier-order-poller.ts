import { Injectable, Logger } from '@nestjs/common';
import { DelayedError, type Job } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { runWithTenant } from '../../../common/tenant/tenant-context';
import { forEachActiveOrg } from '../../../common/scheduler/for-each-active-org';
import { IntegrationLogService } from '../../integration-logs/integration-log.service';
import { SettingsService } from '../../settings/settings.service';
import { SupplierAdapterRegistry } from '../adapters/supplier-adapter-registry';
import type { SupplierOrderState } from '../adapters/supplier-adapter.interface';
import { loadConnection, toConnectionContext } from '../connections/supplier-connection-context';
import { SupplierRateLimitError } from '../http/supplier-errors';
import { errorText } from '../processors/supplier-job-errors';
import {
  adjustForPartial,
  matchConfirmedLines,
  POLLABLE_SUPPLIER_ORDER_STATUSES,
  TERMINAL_SUPPLIER_ORDER_STATUSES,
} from './supplier-order-lines';
import { ORDER_WITH_LINES, toOrderInput, type OrderRow } from './supplier-order-sender';
import { SupplierOrdersService } from './supplier-orders.service';

/** Опитування зупиняється, якщо замовлення так і не завершилось за цей час. */
const MAX_POLL_AGE_MS = 30 * 86_400_000;
/** Скільки замовлень опитувати за прохід `poll-due` на організацію. */
const DUE_BATCH = 100;

/**
 * Статуси замовлень у постачальника (BR-SCON-012): повторювана `poll-due` для нетермінальних
 * із настанням `nextPollAt` і `poll-now` («Оновити статус»). Сирий статус → нормалізований за
 * таблицею адаптера; невідомий нормалізованого не змінює. Зовнішній статус НЕ змінює
 * залишків, боргу й FSM замовлення — лише рядки SupplierOrder і підсумок `supplierApiStatus`.
 */
@Injectable()
export class SupplierOrderPoller {
  private readonly logger = new Logger(SupplierOrderPoller.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SupplierAdapterRegistry,
    private readonly integrationLog: IntegrationLogService,
    private readonly settings: SettingsService,
    private readonly orders: SupplierOrdersService,
  ) {}

  async pollDue(): Promise<void> {
    await forEachActiveOrg(this.prisma, async orgIds => {
      for (const orgId of orgIds) {
        await runWithTenant({ orgId }, async () => {
          const due = await this.prisma.supplierOrder.findMany({
            where: {
              orgId,
              deletedAt: null,
              status: { in: [...POLLABLE_SUPPLIER_ORDER_STATUSES] },
              nextPollAt: { lte: new Date() },
            },
            include: ORDER_WITH_LINES,
            orderBy: { nextPollAt: 'asc' },
            take: DUE_BATCH,
          });
          if (due.length === 0) return;
          const minutes = (await this.settings.getOrganisationSettings(orgId))
            .supplierOrderPollIntervalMinutes;
          const touched = new Set<string>();
          for (const o of due) {
            try {
              await this.pollOne(orgId, o, minutes);
            } catch (e) {
              const wait = e instanceof SupplierRateLimitError ? e.retryAfterMs : minutes * 60_000;
              await this.prisma.supplierOrder.updateMany({
                where: { id: o.id, orgId },
                data: { lastPolledAt: new Date(), nextPollAt: new Date(Date.now() + wait) },
              });
              this.logger.warn(`Статус ${o.reference}: ${errorText(e)}`);
            }
            touched.add(o.purchaseOrderId);
          }
          for (const id of touched) await this.orders.refreshSummary(orgId, id);
        });
      }
    });
  }

  /** «Оновити статус»: усі нетермінальні зовнішні замовлення цього замовлення — зараз. */
  async pollPurchaseOrder(
    job: Job<{ orgId: string; purchaseOrderId: string }>,
    token: string | undefined,
  ): Promise<void> {
    const { orgId, purchaseOrderId } = job.data;
    const list = await this.prisma.supplierOrder.findMany({
      where: {
        orgId,
        purchaseOrderId,
        deletedAt: null,
        status: { in: [...POLLABLE_SUPPLIER_ORDER_STATUSES] },
      },
      include: ORDER_WITH_LINES,
      take: 100,
    });
    const minutes = (await this.settings.getOrganisationSettings(orgId))
      .supplierOrderPollIntervalMinutes;
    try {
      for (const o of list) await this.pollOne(orgId, o, minutes);
    } catch (e) {
      if (e instanceof SupplierRateLimitError) {
        await job.moveToDelayed(Date.now() + e.retryAfterMs, token);
        throw new DelayedError();
      }
      throw e;
    } finally {
      await this.orders.refreshSummary(orgId, purchaseOrderId);
    }
  }

  async pollOne(orgId: string, o: OrderRow, pollMinutes: number): Promise<void> {
    const row = await loadConnection(this.prisma, orgId, o.connectionId);
    if (!row) return;
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: o.purchaseOrderId, orgId },
      select: { number: true, warehouseId: true },
    });
    if (!po) return;
    const conn = toConnectionContext(row);
    const adapter = this.registry.get(conn.provider);
    const input = toOrderInput(o, po);
    const state: SupplierOrderState = {
      step: o.step,
      externalCartId: o.externalCartId,
      externalOrderId: o.externalOrderId,
      externalNumber: o.externalNumber,
    };
    const now = new Date();
    const next = new Date(now.getTime() + pollMinutes * 60_000);
    const log = (operation: string) => ({
      orgId,
      provider: conn.provider,
      operation,
      documentType: 'PurchaseOrder',
      documentId: o.purchaseOrderId,
    });

    if (o.status === 'UNKNOWN') {
      // BR-SCON-011: замовлення могло з'явитись у постачальника пізніше — звірка ще раз.
      const found = await this.integrationLog.wrap(log('reconcile'), () =>
        adapter.findOrderByReference(conn, input, state),
      );
      await this.prisma.supplierOrder.updateMany({
        where: { id: o.id, orgId },
        data: found
          ? {
              status: 'PLACED',
              externalOrderId: found.externalOrderId,
              externalNumber: found.externalNumber,
              error: null,
              lastPolledAt: now,
              nextPollAt: now,
            }
          : { lastPolledAt: now, nextPollAt: this.stopAfter(o, next) },
      });
      return;
    }
    if (!o.externalOrderId && !o.externalCartId) return;

    const res = await this.integrationLog.wrap(log('orderStatus'), () =>
      adapter.getOrderStatus(conn, input, state),
    );
    if (res.status === null) {
      this.logger.warn(
        `${conn.provider}: невідомий статус «${res.statusRaw}» замовлення ${o.reference}`,
      );
    }
    const updates = matchConfirmedLines(o.lines, res.lines);
    const status = adjustForPartial(res.status ?? o.status, o.lines, updates);
    const terminal = TERMINAL_SUPPLIER_ORDER_STATUSES.includes(status);
    await this.prisma.$transaction(async tx => {
      for (const u of updates) {
        await tx.supplierOrderLine.updateMany({
          where: { id: u.id, orgId },
          data: {
            qtyConfirmed: u.qtyConfirmed,
            priceConfirmed: u.priceConfirmed,
            statusRaw: u.statusRaw,
            externalLineId: u.externalLineId,
          },
        });
      }
      await tx.supplierOrder.updateMany({
        where: { id: o.id, orgId },
        data: {
          status,
          externalStatusRaw: res.statusRaw.slice(0, 300),
          externalNumber: res.externalNumber ?? o.externalNumber,
          lastPolledAt: now,
          nextPollAt: terminal ? null : this.stopAfter(o, next),
          ...(!o.confirmedAt &&
          ['CONFIRMED', 'PARTIALLY_CONFIRMED', 'READY', 'SHIPPED'].includes(status)
            ? { confirmedAt: now }
            : {}),
        },
      });
    });
  }

  /** Замовлення, що не завершилось за MAX_POLL_AGE_MS, більше не опитується (стеля). */
  private stopAfter(o: OrderRow, next: Date): Date | null {
    const since = (o.sentAt ?? o.createdAt).getTime();
    return Date.now() - since > MAX_POLL_AGE_MS ? null : next;
  }
}
