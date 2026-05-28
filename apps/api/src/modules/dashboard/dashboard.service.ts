import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';

interface DashboardSummary {
  activeWo: number;
  todayRevenue: number;
  pendingInvoices: number;
  lowStockCount: number;
  timestamp: string;
}

// Dashboard is polled every 30s via SSE — cache for 25s so each SSE tick
// returns fresh data but we never hit the DB more than once per interval.
const DASHBOARD_TTL = 25;

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Отримати поточний стан дашборду для організації.
   * Повертає: активні наряди, виручку сьогодні, очікуючі рахунки, низькі залишки.
   */
  async getSummary(orgId: string): Promise<DashboardSummary> {
    const cacheKey = `dashboard:summary:${orgId}`;
    const cached = await this.cache.get<DashboardSummary>(cacheKey);
    if (cached) return cached;
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

        // Низькі залишки: StockItem де `quantity <= minStock` (per-warehouse minStock).
        // Bug #83: попередня версія повертала ВСЮ кількість stock_items (без фільтра),
        // дашборд показував misleading number. Узгоджуємо з /stock-items/low —
        // через raw COUNT (Prisma не підтримує cross-field порівняння у where).
        // Schema без @map → колонки camelCase у Postgres → подвійні лапки обов'язкові.
        this.prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*)::bigint AS count
          FROM stock_items si
          JOIN goods g ON g.id = si."goodId"
          JOIN warehouses w ON w.id = si."warehouseId"
          WHERE si."orgId" = ${orgId}::uuid
            AND si."deletedAt" IS NULL
            AND g."deletedAt" IS NULL
            AND w."deletedAt" IS NULL
            AND si."minStock" IS NOT NULL
            AND si.quantity <= si."minStock"
        `,
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

    // `$queryRaw` returns Array<{ count: bigint }>; extract the single row.
    // `Number(bigint)` is safe — low-stock counts are far below 2^53.
    const lowStock =
      lowStockCount.status === 'fulfilled' && lowStockCount.value.length > 0
        ? Number(lowStockCount.value[0].count)
        : 0;

    const result: DashboardSummary = {
      activeWo,
      todayRevenue,
      pendingInvoices,
      lowStockCount: lowStock,
      timestamp: now.toISOString(),
    };
    await this.cache.set(cacheKey, result, DASHBOARD_TTL);
    return result;
  }
}
