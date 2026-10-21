import { HttpException, Injectable } from '@nestjs/common';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
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
import {
  errorText,
  handleSupplierJobError,
  isLastAttempt,
} from '../processors/supplier-job-errors';
import {
  createPlaceOrderRunner,
  DONE_STEP,
  needsReconcile,
  PENDING_SUFFIX,
} from './place-order-runner';
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
    if (po.status === 'CANCELLED') return this.cancelQueued(orgId, purchaseOrderId);
    let lockedStatus: string | null;
    try {
      lockedStatus = await this.prisma.$transaction(
        async tx => {
          await this.orders.lockPo(tx, orgId, purchaseOrderId);
          // Скасування могло закомітитись між першим читанням і блокуванням — план не будуємо.
          const fresh = await tx.purchaseOrder.findFirst({
            where: { id: purchaseOrderId, orgId, deletedAt: null },
            select: { status: true },
          });
          if (!fresh || fresh.status === 'CANCELLED') return fresh?.status ?? null;
          await this.orders.ensurePlannedInTx(tx, orgId, purchaseOrderId, null);
          return fresh.status;
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
    if (lockedStatus === null) return;
    if (lockedStatus === 'CANCELLED') return this.cancelQueued(orgId, purchaseOrderId);
    const pending = await this.prisma.supplierOrder.findMany({
      where: { orgId, purchaseOrderId, deletedAt: null, status: { in: ['QUEUED', 'SENDING'] } },
      include: ORDER_WITH_LINES,
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    const s = await this.settings.getOrganisationSettings(orgId);
    // Остаточна відмова одного зовнішнього замовлення (рядок уже FAILED / UNKNOWN) не лишає решту
    // зовнішніх замовлень цього замовлення в QUEUED: обходимо всі, помилку кидаємо наприкінці.
    // Ліміт (DelayedError — задачу вже відкладено) і повторювана помилка не на останній спробі —
    // одразу нагору: повтор задачі продовжить із невідправлених.
    let finalError: Error | null = null;
    try {
      for (const o of pending) {
        if (await this.poCancelled(orgId, purchaseOrderId)) break;
        try {
          await this.placeOne(
            job,
            token,
            orgId,
            purchaseOrderId,
            po,
            o,
            s.supplierOrderPollIntervalMinutes,
          );
        } catch (e) {
          const final =
            e instanceof UnrecoverableError || (!(e instanceof DelayedError) && isLastAttempt(job));
          if (!final) throw e;
          finalError ??= e instanceof Error ? e : new Error(String(e));
        }
      }
    } finally {
      await this.orders.refreshSummary(orgId, purchaseOrderId);
    }
    if (finalError) throw finalError;
  }

  /** Скасоване до відправки — нічого не відправляємо (BR-SCON-014). */
  private async cancelQueued(orgId: string, purchaseOrderId: string): Promise<void> {
    await this.prisma.supplierOrder.updateMany({
      where: { orgId, purchaseOrderId, deletedAt: null, status: 'QUEUED' },
      data: { status: 'CANCELLED' },
    });
    await this.orders.refreshSummary(orgId, purchaseOrderId);
  }

  private async poCancelled(orgId: string, purchaseOrderId: string): Promise<boolean> {
    const p = await this.prisma.purchaseOrder.findFirst({
      where: { id: purchaseOrderId, orgId, deletedAt: null },
      select: { status: true },
    });
    return !p || p.status === 'CANCELLED';
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
    // Захоплення рядка: скасований між вибіркою й відправкою (CANCELLED) не «воскресає».
    const claimed = await this.prisma.supplierOrder.updateMany({
      where: { id: o.id, orgId, deletedAt: null, status: { in: ['QUEUED', 'SENDING'] } },
      data: { status: 'SENDING' },
    });
    if (claimed.count === 0) return;
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
      // Неповторюваний крок почався — запит міг дійти: sentAt фіксується вже тут, щоб звірка
      // (UTR шукає за датою відправки) і стеля опитування рахувались від справжньої відправки.
      let sentAt = o.sentAt;
      const runner = createPlaceOrderRunner(adapter.orderSteps, state, patch => {
        const stamp = !sentAt && !!patch.step?.endsWith(PENDING_SUFFIX);
        if (stamp) sentAt = new Date();
        return this.update(orgId, o.id, stamp ? { ...patch, sentAt } : patch);
      });
      const result = await this.integrationLog.wrap(log('placeOrder'), () =>
        adapter.placeOrder(conn, input, runner),
      );
      await this.applyPlaced(orgId, { ...o, sentAt }, runner.state, result, pollMinutes);
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
    await this.prisma.$transaction(
      async tx => {
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
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
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
