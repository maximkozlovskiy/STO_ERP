import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BALANCE_SIGN } from '../settlements/settlements.service';

export interface ReconcileJob {
  orgId: string;
}

// Допуск для порівняння float-залишків (IEEE-754 дрейф) і копійок.
const QTY_EPSILON = 1e-6;
const MONEY_EPSILON = 0.01;

/**
 * A3 — per-org звірка інваріантів на ЖИВІЙ БД (read-only, drift-detection). Інваріанти тримаються
 * за конструкцією у транзакціях (inventory/settlements/payments), але баг/ручний SQL/незакрита tx
 * можуть їх розсинхронити тихо. Цей джоб рахує агрегати й ЛОГУЄ розбіжність (logger.error) —
 * НЕ авто-виправляє (щоб самому не стати джерелом дрейфу). Оператор/розробник бачить у логах.
 *
 * 3 звірки:
 *   1. StockItem.quantity  vs  Σ StockBatch.remainingQty (той самий (good,warehouse)).
 *   2. SettlementAccount.balance  vs  Σ SettlementTransaction.amount × BALANCE_SIGN[type].
 *   3. Invoice.paidAmount  vs  Σ Payment.amount (по invoiceId).
 */
@Injectable()
@Processor('reconciliation', { concurrency: 1 })
export class ReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(ReconciliationProcessor.name);

  async process(job: Job<ReconcileJob>): Promise<void> {
    const { orgId } = job.data;
    const [stockDrift, balanceDrift, paidDrift] = await Promise.all([
      this.checkStock(orgId),
      this.checkBalances(orgId),
      this.checkInvoicePaid(orgId),
    ]);
    const total = stockDrift + balanceDrift + paidDrift;
    if (total === 0) {
      this.logger.log(`Reconciliation org=${orgId}: інваріанти консистентні (0 розбіжностей)`);
    } else {
      this.logger.warn(
        `Reconciliation org=${orgId}: знайдено ${total} розбіжностей (stock=${stockDrift}, balance=${balanceDrift}, paid=${paidDrift}) — див. error-логи вище`,
      );
    }
  }

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /** StockItem.quantity vs Σ активних StockBatch.remainingQty по (good, warehouse). */
  private async checkStock(orgId: string): Promise<number> {
    const [items, batches] = await Promise.all([
      this.prisma.stockItem.findMany({
        where: { orgId, deletedAt: null },
        select: { goodId: true, warehouseId: true, quantity: true },
      }),
      this.prisma.stockBatch.groupBy({
        by: ['goodId', 'warehouseId'],
        where: { orgId, isActive: true },
        _sum: { remainingQty: true },
      }),
    ]);
    const batchSum = new Map<string, number>();
    for (const b of batches) {
      batchSum.set(`${b.goodId}:${b.warehouseId}`, b._sum.remainingQty ?? 0);
    }
    let drift = 0;
    for (const it of items) {
      const expected = batchSum.get(`${it.goodId}:${it.warehouseId}`) ?? 0;
      if (Math.abs(it.quantity - expected) > QTY_EPSILON) {
        drift++;
        this.logger.error(
          `DRIFT stock org=${orgId} good=${it.goodId} wh=${it.warehouseId}: StockItem.quantity=${it.quantity} ≠ Σbatch=${expected} (Δ=${it.quantity - expected})`,
        );
      }
    }
    return drift;
  }

  /** SettlementAccount.balance vs Σ SettlementTransaction × BALANCE_SIGN. */
  private async checkBalances(orgId: string): Promise<number> {
    const [accounts, txns] = await Promise.all([
      // SettlementAccount — без soft-delete (append-only фінансова сутність).
      this.prisma.settlementAccount.findMany({
        where: { orgId },
        select: { id: true, balance: true },
      }),
      this.prisma.settlementTransaction.groupBy({
        by: ['settlementAccountId', 'type'],
        where: { orgId },
        _sum: { amount: true },
      }),
    ]);
    // Σ по акаунту з урахуванням знака типу.
    const expectedByAccount = new Map<string, number>();
    for (const t of txns) {
      const signed = BALANCE_SIGN[t.type] * Number(t._sum.amount ?? 0);
      expectedByAccount.set(
        t.settlementAccountId,
        (expectedByAccount.get(t.settlementAccountId) ?? 0) + signed,
      );
    }
    let drift = 0;
    for (const acc of accounts) {
      const expected = expectedByAccount.get(acc.id) ?? 0;
      const actual = Number(acc.balance);
      if (Math.abs(actual - expected) > MONEY_EPSILON) {
        drift++;
        this.logger.error(
          `DRIFT balance org=${orgId} account=${acc.id}: balance=${actual} ≠ Σtx×sign=${expected} (Δ=${actual - expected})`,
        );
      }
    }
    return drift;
  }

  /** Invoice.paidAmount vs Σ Payment.amount по invoiceId. */
  private async checkInvoicePaid(orgId: string): Promise<number> {
    const [invoices, payments] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { orgId, deletedAt: null },
        select: { id: true, paidAmount: true },
      }),
      // Payment — append-only (без deletedAt): усі рядки враховуються.
      this.prisma.payment.groupBy({
        by: ['invoiceId'],
        where: { orgId, invoiceId: { not: null } },
        _sum: { amount: true },
      }),
    ]);
    const paidByInvoice = new Map<string, number>();
    for (const p of payments) {
      if (p.invoiceId) paidByInvoice.set(p.invoiceId, Number(p._sum.amount ?? 0));
    }
    let drift = 0;
    for (const inv of invoices) {
      const expected = paidByInvoice.get(inv.id) ?? 0;
      const actual = Number(inv.paidAmount);
      if (Math.abs(actual - expected) > MONEY_EPSILON) {
        drift++;
        this.logger.error(
          `DRIFT paidAmount org=${orgId} invoice=${inv.id}: paidAmount=${actual} ≠ Σpayment=${expected} (Δ=${actual - expected})`,
        );
      }
    }
    return drift;
  }
}
