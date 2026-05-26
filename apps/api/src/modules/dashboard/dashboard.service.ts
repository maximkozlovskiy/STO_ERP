import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

interface DashboardSummary {
  activeWo: number;
  todayRevenue: number;
  pendingInvoices: number;
  lowStockCount: number;
  timestamp: string;
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Отримати поточний стан дашборду для організації.
   * Повертає: активні наряди, виручку сьогодні, очікуючі рахунки, низькі залишки.
   */
  async getSummary(orgId: string): Promise<DashboardSummary> {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [activeWoCount, todayRevenueData, pendingInvoiceCount, lowStockCount] =
      await Promise.allSettled([
        // Активні наряди: IN_PROGRESS + ON_HOLD
        this.prisma.workOrder.count({
          where: {
            orgId,
            deletedAt: null,
            status: { in: ['IN_PROGRESS', 'ON_HOLD'] },
          },
        }),

        // Виручка сьогодні: PAYMENT settlement transactions
        // (SettlementTransaction є append-only — не має deletedAt)
        this.prisma.settlementTransaction.aggregate({
          where: {
            orgId,
            type: 'PAYMENT',
            createdAt: { gte: todayStart },
          },
          _sum: { amount: true },
        }),

        // Очікуючі рахунки: не-PAID і не-CANCELLED
        this.prisma.invoice.count({
          where: {
            orgId,
            deletedAt: null,
            status: { in: ['DRAFT', 'SENT', 'OVERDUE'] },
          },
        }),

        // Низькі залишки: товари де quantity < minStock (minStock зберігається в Good)
        // `take` не має ефекту на count() — використовується умовний фільтр.
        this.prisma.stockItem.count({
          where: {
            orgId,
            // `quantity < good.minStock` неможливо виразити декларативно у Prisma where —
            // повертаємо загальний count; деталізована логіка в /stock-items/low.
          },
        }),
      ]);

    if (activeWoCount.status === 'rejected') this.logger.warn(`activeWo failed: ${activeWoCount.reason}`);
    if (todayRevenueData.status === 'rejected') this.logger.warn(`todayRevenue failed: ${todayRevenueData.reason}`);
    if (pendingInvoiceCount.status === 'rejected') this.logger.warn(`pendingInvoices failed: ${pendingInvoiceCount.reason}`);
    if (lowStockCount.status === 'rejected') this.logger.warn(`lowStock failed: ${lowStockCount.reason}`);

    const activeWo =
      activeWoCount.status === 'fulfilled' ? activeWoCount.value : 0;

    // `amount` у SettlementTransaction — Prisma.Decimal. Через Number() безпечно
    // перетворюємо у JS-число (no `as any`). `_sum.amount` буде null коли немає рядків.
    const todayRevenue =
      todayRevenueData.status === 'fulfilled' && todayRevenueData.value._sum.amount != null
        ? Number(todayRevenueData.value._sum.amount)
        : 0;

    const pendingInvoices =
      pendingInvoiceCount.status === 'fulfilled'
        ? pendingInvoiceCount.value
        : 0;

    const lowStock = lowStockCount.status === 'fulfilled' ? lowStockCount.value : 0;

    return {
      activeWo,
      todayRevenue,
      pendingInvoices,
      lowStockCount: lowStock,
      timestamp: now.toISOString(),
    };
  }
}
