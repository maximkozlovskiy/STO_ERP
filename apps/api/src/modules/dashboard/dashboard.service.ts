import { Injectable } from '@nestjs/common';
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
        // Note: deletedAt check skipped due to Prisma schema variance
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

        // Низькі залишки: простий count для демо
        // TODO: під час реальної міграції додати мінімальні залишки з Good модели
        this.prisma.stockItem.count({
          where: {
            orgId,
          },
          take: 10000,
        }),
      ]);

    // Розпакувати результати з allSettled
    const activeWo =
      activeWoCount.status === 'fulfilled' ? activeWoCount.value : 0;

    const todayRevenue =
      todayRevenueData.status === 'fulfilled' &&
      todayRevenueData.value._sum &&
      todayRevenueData.value._sum.amount
        ? (todayRevenueData.value._sum.amount as any).toNumber()
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
      lowStockCount: Math.min(lowStock, 10), // Cap at 10 for demo
      timestamp: now.toISOString(),
    };
  }
}
