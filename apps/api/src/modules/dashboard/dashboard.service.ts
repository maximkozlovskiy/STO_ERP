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

// Each sub-query has 8s hard ceiling — на повільному Postgres або при connection
// pool starvation один запит не повинен блокувати SSE tick. Timeout повертає null,
// поле сумарно стає 0; основний контракт getSummary() ніколи не кидає exception.
const SUBQUERY_TIMEOUT_MS = 8_000;

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Promise.race з timeout — обгортка для sub-queries у getSummary.
   * При timeout resolve(null) замість reject — щоб одне повільне поле не валило
   * увесь дашборд. setTimeout.unref() щоб не тримати event loop alive.
   */
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return Promise.race([
      p,
      new Promise<null>(resolve => {
        const id = setTimeout(() => resolve(null), ms);
        if (typeof id === 'object' && id !== null && 'unref' in id) {
          (id as { unref: () => void }).unref();
        }
      }),
    ]);
  }

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

    // Кожен sub-query обгорнутий у withTimeout: 8s ceiling — slow Postgres або
    // connection-pool starvation не повинен зривати SSE tick. Timeout → null,
    // поле стане 0. Promise.allSettled поверх — додатковий захист від exceptions.
    const [activeWoCount, todayRevenueData, pendingInvoiceCount, lowStockCount] =
      await Promise.allSettled([
        // Активні наряди: IN_PROGRESS + ON_HOLD
        this.withTimeout(
          this.prisma.workOrder.count({
            where: {
              orgId,
              deletedAt: null,
              status: { in: ['IN_PROGRESS', 'ON_HOLD'] },
            },
          }),
          SUBQUERY_TIMEOUT_MS,
        ),

        // Виручка сьогодні: PAYMENT settlement transactions
        // (SettlementTransaction є append-only — не має deletedAt)
        this.withTimeout(
          this.prisma.settlementTransaction.aggregate({
            where: {
              orgId,
              type: 'PAYMENT',
              createdAt: { gte: todayStart },
            },
            _sum: { amount: true },
          }),
          SUBQUERY_TIMEOUT_MS,
        ),

        // Очікуючі рахунки: не-PAID і не-CANCELLED
        this.withTimeout(
          this.prisma.invoice.count({
            where: {
              orgId,
              deletedAt: null,
              status: { in: ['DRAFT', 'SENT', 'OVERDUE'] },
            },
          }),
          SUBQUERY_TIMEOUT_MS,
        ),

        // Низькі залишки: StockItem де `quantity <= minStock` (per-warehouse minStock).
        // Bug #83: попередня версія повертала ВСЮ кількість stock_items (без фільтра),
        // дашборд показував misleading number. Узгоджуємо з /stock-items/low —
        // через raw COUNT (Prisma не підтримує cross-field порівняння у where).
        // Schema без @map → колонки camelCase у Postgres → подвійні лапки обов'язкові.
        this.withTimeout(
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
          SUBQUERY_TIMEOUT_MS,
        ),
      ]);

    if (activeWoCount.status === 'rejected')
      this.logger.warn(`activeWo failed: ${activeWoCount.reason}`);
    else if (activeWoCount.value === null)
      this.logger.warn(`activeWo timeout (${SUBQUERY_TIMEOUT_MS}ms)`);
    if (todayRevenueData.status === 'rejected')
      this.logger.warn(`todayRevenue failed: ${todayRevenueData.reason}`);
    else if (todayRevenueData.value === null)
      this.logger.warn(`todayRevenue timeout (${SUBQUERY_TIMEOUT_MS}ms)`);
    if (pendingInvoiceCount.status === 'rejected')
      this.logger.warn(`pendingInvoices failed: ${pendingInvoiceCount.reason}`);
    else if (pendingInvoiceCount.value === null)
      this.logger.warn(`pendingInvoices timeout (${SUBQUERY_TIMEOUT_MS}ms)`);
    if (lowStockCount.status === 'rejected')
      this.logger.warn(`lowStock failed: ${lowStockCount.reason}`);
    else if (lowStockCount.value === null)
      this.logger.warn(`lowStock timeout (${SUBQUERY_TIMEOUT_MS}ms)`);

    const activeWo =
      activeWoCount.status === 'fulfilled' && activeWoCount.value !== null
        ? activeWoCount.value
        : 0;

    // `amount` у SettlementTransaction — Prisma.Decimal. Через Number() безпечно
    // перетворюємо у JS-число (no `as any`). `_sum.amount` буде null коли немає рядків.
    const todayRevenue =
      todayRevenueData.status === 'fulfilled' &&
      todayRevenueData.value !== null &&
      todayRevenueData.value._sum.amount != null
        ? Number(todayRevenueData.value._sum.amount)
        : 0;

    const pendingInvoices =
      pendingInvoiceCount.status === 'fulfilled' && pendingInvoiceCount.value !== null
        ? pendingInvoiceCount.value
        : 0;

    // `$queryRaw` returns Array<{ count: bigint }>; extract the single row.
    // `Number(bigint)` is safe — low-stock counts are far below 2^53.
    const lowStock =
      lowStockCount.status === 'fulfilled' &&
      lowStockCount.value !== null &&
      lowStockCount.value.length > 0
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
