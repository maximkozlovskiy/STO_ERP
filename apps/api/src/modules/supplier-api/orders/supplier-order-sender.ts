import { HttpException, Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../../prisma/prisma.service';
import { IntegrationLogService } from '../../integration-logs/integration-log.service';
import { SettingsService } from '../../settings/settings.service';
import { SupplierAdapterRegistry } from '../adapters/supplier-adapter-registry';
import type {
  PlacedOrderResult,
  SupplierOrderInput,
  SupplierOrderState,
} from '../adapters/supplier-adapter.interface';
import { loadConnection, toConnectionContext } from '../connections/supplier-connection-context';
import { errorText, handleSupplierJobError } from '../processors/supplier-job-errors';
import { createPlaceOrderRunner, DONE_STEP, needsReconcile } from './place-order-runner';
import { adjustForPartial, matchConfirmedLines } from './supplier-order-lines';
import { SupplierOrdersService } from './supplier-orders.service';

export interface SupplierPlaceJob {
  orgId: string;
  purchaseOrderId: string;
}

const ORDER_WITH_LINES = {
  lines: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' }, take: 1000 },
} as const satisfies Prisma.SupplierOrderInclude;
type OrderRow = Prisma.SupplierOrderGetPayload<{ include: typeof ORDER_WITH_LINES }>;

export const UNKNOWN_ORDER_MESSAGE =
  'Невідомо, чи прийняв постачальник замовлення — перевірте в кабінеті постачальника';

/**
 * Задача `place` черги `supplier-order` (BR-SCON-010, 011): план (outbox-шлях) → кожне зовнішнє
 * замовлення по кроках адаптера. Крок записується до наступного; рестарт продовжує з
 * записаного; після неоднозначної відмови неповторюваного кроку наступна спроба лише звіряє
 * за `reference` — знайдено → PLACED, ні → UNKNOWN (замовлення NEEDS_ATTENTION). Повторного
 * оформлення без перевірки немає.
 */
@Injectable()
export class SupplierOrderSender {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SupplierAdapterRegistry,
    private readonly integrationLog: IntegrationLogService,
    private readonly settings: SettingsService,
    private readonly orders: SupplierOrdersService,
  ) {}

  async run(job: Job<SupplierPlaceJob>, token: string | undefined): Promise<void> {
    const { orgId, purchaseOrderId } = job.data;
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: purchaseOrderId, orgId, deletedAt: null },
      select: { status: true, number: true, warehouseId: true },
    });
    if (!po) return;
    if (po.status === 'CANCELLED') {
      // Скасоване до відправки — нічого не відправляємо (BR-SCON-014).
      await this.prisma.supplierOrder.updateMany({
        where: { orgId, purchaseOrderId, deletedAt: null, status: 'QUEUED' },
        data: { status: 'CANCELLED' },
      });
      await this.orders.refreshSummary(orgId, purchaseOrderId);
      return;
    }
    try {
      await this.prisma.$transaction(
        async tx => {
          await this.orders.lockPo(tx, orgId, purchaseOrderId);
          await this.orders.ensurePlannedInTx(tx, orgId, purchaseOrderId, null);
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
    } catch (e) {
      // План неможливий (немає пропозиції, вимкнене підключення…) — повтор не допоможе.
      if (e instanceof HttpException) {
        const message = errorText(e);
        await this.orders.markPlanFailed(orgId, purchaseOrderId, message);
        throw new UnrecoverableError(message);
      }
      throw e;
    }
    const pending = await this.prisma.supplierOrder.findMany({
      where: { orgId, purchaseOrderId, deletedAt: null, status: { in: ['QUEUED', 'SENDING'] } },
      include: ORDER_WITH_LINES,
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    const s = await this.settings.getOrganisationSettings(orgId);
    try {
      for (const o of pending) {
        await this.placeOne(
          job,
          token,
          orgId,
          purchaseOrderId,
          po,
          o,
          s.supplierOrderPollIntervalMinutes,
        );
      }
    } finally {
      await this.orders.refreshSummary(orgId, purchaseOrderId);
    }
  }

  private async placeOne(
    job: Job<SupplierPlaceJob>,
    token: string | undefined,
    orgId: string,
    purchaseOrderId: string,
    po: { number: string; warehouseId: string },
    o: OrderRow,
    pollMinutes: number,
  ): Promise<void> {
    const row = await loadConnection(this.prisma, orgId, o.connectionId);
    if (!row || !row.enabled) {
      await this.update(orgId, o.id, {
        status: 'FAILED',
        error: 'Підключення до API постачальника вимкнене або видалене',
      });
      return;
    }
    const conn = toConnectionContext(row);
    const adapter = this.registry.get(conn.provider);
    const input = toOrderInput(o, po);
    const state: SupplierOrderState = {
      step: o.step,
      externalCartId: o.externalCartId,
      externalOrderId: o.externalOrderId,
      externalNumber: o.externalNumber,
    };
    const log = (operation: string) => ({
      orgId,
      provider: conn.provider,
      operation,
      documentType: 'PurchaseOrder',
      documentId: purchaseOrderId,
    });
    await this.update(orgId, o.id, { status: 'SENDING' });
    try {
      if (needsReconcile(o.step)) {
        const found = await this.integrationLog.wrap(log('reconcile'), () =>
          adapter.findOrderByReference(conn, input, state),
        );
        if (found) {
          await this.applyPlaced(
            orgId,
            o,
            { ...state, ...found },
            { status: 'PLACED', statusRaw: null },
            pollMinutes,
          );
        } else {
          await this.update(orgId, o.id, {
            status: 'UNKNOWN',
            step: DONE_STEP,
            error: UNKNOWN_ORDER_MESSAGE,
          });
        }
        return;
      }
      const runner = createPlaceOrderRunner(adapter.orderSteps, state, patch =>
        this.update(orgId, o.id, patch),
      );
      const result = await this.integrationLog.wrap(log('placeOrder'), () =>
        adapter.placeOrder(conn, input, runner),
      );
      await this.applyPlaced(orgId, o, runner.state, result, pollMinutes);
    } catch (e) {
      return handleSupplierJobError(job, token, e, {
        onFinal: async message => {
          const current = await this.prisma.supplierOrder.findFirst({
            where: { id: o.id, orgId },
            select: { step: true },
          });
          // Вичерпано спроби посеред неоднозначного кроку — не «не сталося», а «невідомо».
          const unknown = needsReconcile(current?.step);
          await this.update(orgId, o.id, {
            status: unknown ? 'UNKNOWN' : 'FAILED',
            error: unknown ? `${UNKNOWN_ORDER_MESSAGE} (${message})` : message,
          });
        },
        onRetry: message => this.update(orgId, o.id, { error: message }),
      });
    }
  }

  private async applyPlaced(
    orgId: string,
    o: OrderRow,
    state: SupplierOrderState,
    result: PlacedOrderResult,
    pollMinutes: number,
  ): Promise<void> {
    const updates = matchConfirmedLines(o.lines, result.lines);
    const status = adjustForPartial(result.status, o.lines, updates);
    const now = new Date();
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
          step: DONE_STEP,
          externalCartId: state.externalCartId,
          externalOrderId: state.externalOrderId,
          externalNumber: state.externalNumber,
          externalStatusRaw: result.statusRaw?.slice(0, 300) ?? null,
          sentAt: o.sentAt ?? now,
          confirmedAt: status === 'CONFIRMED' || status === 'PARTIALLY_CONFIRMED' ? now : null,
          nextPollAt: new Date(now.getTime() + pollMinutes * 60_000),
          error: null,
        },
      });
    });
  }

  private async update(
    orgId: string,
    id: string,
    data: Prisma.SupplierOrderUncheckedUpdateManyInput,
  ): Promise<void> {
    await this.prisma.supplierOrder.updateMany({ where: { id, orgId }, data });
  }
}

export function toOrderInput(
  o: OrderRow,
  po: { number: string; warehouseId: string },
): SupplierOrderInput {
  return {
    id: o.id,
    reference: o.reference,
    purchaseOrderNumber: po.number,
    supplierWarehouseCode: o.supplierWarehouseCode,
    ourWarehouseId: po.warehouseId,
    sentAt: o.sentAt,
    lines: o.lines.map(l => ({
      lineId: l.id,
      supplierItemId: l.supplierItemId,
      offerKey: l.offerKey,
      warehouseCode: l.warehouseCode,
      qty: l.qtyRequested,
      price: Number(l.priceRequested),
      currencyCode: l.currencyCode,
    })),
  };
}

export { ORDER_WITH_LINES };
export type { OrderRow };
