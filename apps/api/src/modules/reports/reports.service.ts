import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { money, moneyFromDecimal, sumMoney } from '../../common/utils/money';
import { formatPersonName, translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import {
  dateOnlyRangeFilter,
  kyivDayRangeFilter,
  kyivYmd,
  normalizeKyivDateRange,
} from '../../common/utils/kyiv-date';
import { workCapacityHours } from '../../common/utils/work-hours';
import type { PnlReportDto, PnlRowDto, PnlRowKey } from './reports.dto';
import {
  PNL_MAX_MONTHS,
  addToMonth,
  allocatePayrollByMonth,
  buildCategoryRows,
  monthsBetween,
  sumRootRows,
  nettsAdvanceReturns,
  resolvePnlSettings,
  type PnlCategoryRow,
  type PnlSettings,
} from './pnl.calc';

// BR-RPT-023: частка «без ПДВ» наряду k = totalNet / сума рядків (1 для «без ПДВ» і «ПДВ зверху»,
// < 1 для «ПДВ у ціні»; наряд без рядків → 1). Множник для робіт і запчастин у звітах.
const NET_SHARE_SQL = Prisma.sql`COALESCE("totalNet" / NULLIF("totalActualLabor" + "totalParts", 0), 1)`;

// Межі періоду — київська доба зі спільного kyiv-date (раніше тут жила власна копія зсуву).
function normalizeDateRange(from: string, to: string) {
  const { fromDate, toDate } = normalizeKyivDateRange(from, to);
  if (fromDate > toDate)
    throw new BadRequestException(translateError('err.report.startAfterEnd', getLocale()));
  return { fromDate, toDate };
}

// Module-level Intl singletons — locale-data init coштує найбільше у форматерах.
// Hot path: revenue() цикл до 10 000 рядків; уникаємо створення форматера на кожен виклик.
const KYIV_DATE_FMT = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });

// Fallback частки ФОП механіків, якщо налаштування недоступні (0.4=40% типово для UA SMB).
// Основне джерело — OrganisationSettings.laborCostRatio (per-org, читається у profitability).
const DEFAULT_LABOR_COST_RATIO = 0.4;

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async revenue(orgId: string, from: string, to: string, branchId?: string) {
    const { fromDate, toDate } = normalizeDateRange(from, to);

    // DB-side aggregation via DATE_TRUNC at Europe/Kyiv — раніше findMany(take:10000)
    // тягнув повний набір рядків і робив JS reduce у циклі. Тепер Postgres віддає
    // ~30 рядків (по одному на день) безпосередньо у потрібному форматі.
    type RevenueRow = {
      date: Date;
      revenue: number;
      revenueWithVat: number;
      labor: number;
      parts: number;
      count: number;
    };
    // Parallel: optional branch guard + main aggregation — обидва незалежні reads.
    // Якщо branchId передано і філія не знайдена — кидаємо 404, але обидва запити
    // вже виконані (-1 RTT у happy path). Aggregation з фільтром по неіснуючому
    // branchId поверне порожній результат що ми все одно перепишемо exception'ом.
    const [branch, rows] = await Promise.all([
      branchId
        ? this.prisma.garageBranch.findFirst({
            where: { id: branchId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      this.prisma.$queryRaw<RevenueRow[]>`
        SELECT
          -- "completedAt" — timestamp БЕЗ зони, у UTC. Один AT TIME ZONE 'Europe/Kyiv' трактував би
          -- його як київський час і зсував у зворотний бік: усе, завершене між 00:00 і 06:00 за
          -- Києвом, потрапляло у попередній день (Bug #808). Спершу UTC, потім Київ.
          DATE_TRUNC('day', "completedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv') AS date,
          COALESCE(SUM("totalNet"),    0)::float AS revenue,
          COALESCE(SUM("totalAmount"), 0)::float AS "revenueWithVat",
          -- BR-RPT-023: роботи й запчастини теж БЕЗ ПДВ і від ФАКТУ: k = totalNet / сума рядків
          -- (1 для «без ПДВ» і «ПДВ зверху», < 1 для «ПДВ у ціні») → Роботи + Запчастини = Сума.
          COALESCE(SUM(ROUND("totalActualLabor" * ${NET_SHARE_SQL}, 2)), 0)::float AS labor,
          COALESCE(SUM(ROUND("totalParts" * ${NET_SHARE_SQL}, 2)), 0)::float AS parts,
          COUNT(*)::int                          AS count
        FROM work_orders
        WHERE "orgId"       = ${orgId}::uuid
          AND "deletedAt"   IS NULL
          AND "status"      = ANY(ARRAY['COMPLETED','INVOICED','PAID','ARCHIVED']::"WorkOrderStatus"[])
          AND "completedAt" >= ${fromDate}
          AND "completedAt" <= ${toDate}
          ${branchId ? Prisma.sql`AND "branchId" = ${branchId}::uuid` : Prisma.empty}
        GROUP BY 1
        ORDER BY 1
      `,
    ]);
    if (branchId && !branch)
      throw new NotFoundException(translateError('err.branch.notFound', getLocale()));

    // Convert raw rows to API shape; формат `YYYY-MM-DD` через Kyiv-формaтер
    // зберігається ідентичний до попередньої версії.
    // BR-RPT-023: три величини — сума (без ПДВ), ПДВ, сума з ПДВ. ПДВ = різниця двох сум наряду
    // (інваріант BR-WO-007), а не збережений totalVat: у нарядів, завершених до 2026-10-08 в режимі
    // «ПДВ зверху», totalVat записаний, але клієнтові його не нараховували (totalNet = totalAmount).
    const result = rows.map(r => ({
      date: KYIV_DATE_FMT.format(r.date),
      revenue: Number(r.revenue),
      vat: money(Number(r.revenueWithVat) - Number(r.revenue)),
      revenueWithVat: Number(r.revenueWithVat),
      labor: Number(r.labor),
      parts: Number(r.parts),
      count: Number(r.count),
    }));

    // Bug #629: Σ квантованих рядків у JS-float теж дрейфує (0.1+0.2) — квантуємо підсумок
    // до копійки (дзеркалить sumLineTotals / invoice recalcTotals). count — ціле, без money().
    const totalRevenue = sumMoney(result.map(r => r.revenue));
    const totalRevenueWithVat = sumMoney(result.map(r => r.revenueWithVat));
    const totalVat = money(totalRevenueWithVat - totalRevenue);
    const totalOrders = result.reduce((s, r) => s + r.count, 0);

    return {
      rows: result,
      totalRevenue,
      totalVat,
      totalRevenueWithVat,
      totalOrders,
      from,
      to,
    };
  }

  async workOrders(orgId: string, from: string, to: string, employeeId?: string) {
    // Лише перевірка порядку меж: BR-RPT-031 — період за датою документа (@db.Date, календарні
    // дати), як фільтр списку нарядів; київська північ тут не потрібна. Скасовані не рахуються,
    // чернетки — рахуються (перехід із рядка веде у список із тим самим відбором статусів).
    normalizeDateRange(from, to);

    // Use groupBy for DB-side aggregation — avoids loading up to 10 000 raw rows into memory.
    // groupBy requires a filter on the grouped field, so we join through workOrder via raw SQL.
    type GroupRow = {
      employeeId: string;
      firstName: string;
      lastName: string;
      totalNormoHours: number;
      totalAmount: number;
      linesCount: bigint;
    };
    // Parallel: optional employee guard + main aggregation (-1 RTT у happy path).
    const [emp, rows] = await Promise.all([
      employeeId
        ? this.prisma.employee.findFirst({
            where: { id: employeeId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      this.prisma.$queryRaw<GroupRow[]>`
        SELECT
          wol."employeeId",
          e."firstName",
          e."lastName",
          COALESCE(SUM(wol."normoHours"), 0)::float AS "totalNormoHours",
          COALESCE(SUM(wol."amount"), 0)::float     AS "totalAmount",
          COUNT(*)                                   AS "linesCount"
        FROM work_order_lines wol
        JOIN work_orders wo ON wo.id = wol."workOrderId"
        JOIN employees e    ON e.id  = wol."employeeId"
        WHERE wol."orgId"      = ${orgId}::uuid
          AND wol."deletedAt"  IS NULL
          AND wo."orgId"       = ${orgId}::uuid
          AND wo."deletedAt"   IS NULL
          AND wo."documentDate" BETWEEN ${from}::date AND ${to}::date
          AND wo."status"      <> 'CANCELLED'::"WorkOrderStatus"
          ${employeeId ? Prisma.sql`AND wol."employeeId" = ${employeeId}::uuid` : Prisma.empty}
        GROUP BY wol."employeeId", e."firstName", e."lastName"
        ORDER BY "totalAmount" DESC
      `,
    ]);
    if (employeeId && !emp)
      throw new NotFoundException(translateError('err.workOrder.employeeNotFound', getLocale()));

    const result = rows.map(r => ({
      employeeId: r.employeeId,
      employeeName: formatPersonName(r.lastName, r.firstName),
      totalNormoHours: Number(r.totalNormoHours),
      totalAmount: Number(r.totalAmount),
      linesCount: Number(r.linesCount),
    }));

    return {
      rows: result,
      totalNormoHours: result.reduce((s, r) => s + r.totalNormoHours, 0),
      // Bug #629: Σ квантованих грошових рядків у JS-float дрейфує — квантуємо підсумок.
      totalAmount: sumMoney(result.map(r => r.totalAmount)),
      from,
      to,
    };
  }

  async stock(orgId: string, warehouseId?: string, from?: string, to?: string) {
    const stockWhere: { orgId: string; warehouseId?: string; deletedAt: null } = {
      orgId,
      deletedAt: null,
    };
    if (warehouseId) stockWhere.warehouseId = warehouseId;

    const movWhere: {
      orgId: string;
      warehouseId?: string;
      createdAt?: { gte?: Date; lte?: Date };
    } = { orgId };
    if (warehouseId) movWhere.warehouseId = warehouseId;
    const createdAt = kyivDayRangeFilter(from, to);
    if (createdAt) movWhere.createdAt = createdAt;

    type BatchAgg = { goodId: string; warehouseId: string; qty: number; cost: number };

    // Parallel: warehouse guard (optional) + stockItems + stockMovements + партії — незалежні reads.
    const [wh, stockItems, movements, batches] = await Promise.all([
      warehouseId
        ? this.prisma.warehouse.findFirst({
            where: { id: warehouseId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      this.prisma.stockItem.findMany({
        where: stockWhere,
        include: {
          // deletedAt — BR-RPT-032: видалений товар із залишком лишається у звіті з позначкою.
          good: {
            select: {
              name: true,
              sku: true,
              unit: true,
              salePrice: true,
              purchasePrice: true,
              deletedAt: true,
            },
          },
          warehouse: { select: { name: true } },
        },
        orderBy: [{ warehouse: { name: 'asc' } }, { good: { name: 'asc' } }],
        take: 5000,
      }),
      this.prisma.stockMovement.findMany({
        where: movWhere,
        include: { good: { select: { name: true, sku: true } } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      // BR-RPT-034: собівартість залишку — партії (Σ remainingQty × costPrice) на рівні БД: один
      // рядок на товар × склад, скільки б партій не було. Активні партії з ненульовим залишком —
      // той самий відбір, що зважена собівартість (`BatchService.getAverageCost`).
      this.prisma.$queryRaw<BatchAgg[]>`
        SELECT
          "goodId",
          "warehouseId",
          COALESCE(SUM("remainingQty"), 0)::float               AS qty,
          COALESCE(SUM("remainingQty" * "costPrice"), 0)::float AS cost
        FROM stock_batches
        WHERE "orgId" = ${orgId}::uuid
          AND "isActive" = true
          AND "remainingQty" > 0
          ${warehouseId ? Prisma.sql`AND "warehouseId" = ${warehouseId}::uuid` : Prisma.empty}
        GROUP BY "goodId", "warehouseId"
      `,
    ]);
    if (warehouseId && !wh)
      throw new NotFoundException(translateError('err.report.warehouseNotFound', getLocale()));

    const batchBy = new Map(batches.map(b => [`${b.goodId}::${b.warehouseId}`, b]));
    const items = stockItems.map(i => {
      // BR-RPT-034: кількість поза партіями (залишок більший за Σ remainingQty) — за purchasePrice.
      const batch = batchBy.get(`${i.goodId}::${i.warehouseId}`);
      const batchQty = Number(batch?.qty ?? 0);
      const outside = Math.max(i.quantity - batchQty, 0);
      return {
        goodId: i.goodId,
        goodName: i.good.name,
        goodSku: i.good.sku,
        goodDeleted: i.good.deletedAt !== null,
        unit: i.good.unit,
        warehouseName: i.warehouse.name,
        quantity: i.quantity,
        reserved: i.reserved,
        available: i.quantity - i.reserved,
        costValue: money(
          Number(batch?.cost ?? 0) + outside * moneyFromDecimal(i.good.purchasePrice),
        ),
        saleValue: money(i.quantity * moneyFromDecimal(i.good.salePrice)),
      };
    });

    return {
      stockItems: items,
      movements: movements.map(m => ({
        type: m.type,
        goodName: m.good.name,
        quantity: m.quantity,
        documentType: m.documentType,
        createdAt: m.createdAt,
      })),
      totalCostValue: sumMoney(items.map(i => i.costValue)),
      totalSaleValue: sumMoney(items.map(i => i.saleValue)),
    };
  }

  async profitability(orgId: string, from: string, to: string) {
    const { fromDate, toDate } = normalizeDateRange(from, to);

    type WOAgg = {
      totalRevenue: number;
      totalRevenueWithVat: number;
      totalLabor: number;
      ordersCount: bigint;
    };
    type PartAgg = { costParts: number; unknownCount: bigint };

    // Частка ФОП per-org (§13, не hardcoded); clamp [0,1] + fallback при недоступності налаштувань.
    let laborCostRatio = DEFAULT_LABOR_COST_RATIO;
    try {
      const s = await this.settings.getOrganisationSettings(orgId);
      const raw = Number((s as { laborCostRatio?: number }).laborCostRatio);
      if (Number.isFinite(raw)) laborCostRatio = Math.min(Math.max(raw, 0), 1);
    } catch {
      // налаштування недоступні → дефолт (звіт не блокуємо)
    }

    // Two aggregation queries instead of loading up to 10 000 orders × 500 parts each.
    const [woAgg, partAgg] = await Promise.all([
      // Aggregate revenue + labor from work orders
      this.prisma.$queryRaw<WOAgg[]>`
        SELECT
          COALESCE(SUM("totalNet"),    0)::float AS "totalRevenue",
          COALESCE(SUM("totalAmount"), 0)::float AS "totalRevenueWithVat",
          -- BR-RPT-023: база собівартості робіт — фактичні роботи БЕЗ ПДВ (та сама база, що й
          -- виручка); інакше в режимі «ПДВ у ціні» маржа занижувалась на ПДВ робіт.
          COALESCE(SUM(ROUND("totalActualLabor" * ${NET_SHARE_SQL}, 2)), 0)::float AS "totalLabor",
          COUNT(*)                                AS "ordersCount"
        FROM work_orders
        WHERE "orgId"       = ${orgId}::uuid
          AND "deletedAt"   IS NULL
          AND "status"      = ANY(ARRAY['COMPLETED','INVOICED','PAID','ARCHIVED']::"WorkOrderStatus"[])
          AND "completedAt" BETWEEN ${fromDate} AND ${toDate}
      `,
      // Aggregate parts cost with Bug #74 fallback: batchCostPrice → good.purchasePrice
      this.prisma.$queryRaw<PartAgg[]>`
        SELECT
          COALESCE(SUM(
            wop."quantity" * COALESCE(wop."batchCostPrice", g."purchasePrice")
          ), 0)::float AS "costParts",
          COUNT(*) FILTER (WHERE wop."batchCostPrice" IS NULL AND g."purchasePrice" IS NULL) AS "unknownCount"
        FROM work_order_parts wop
        JOIN work_orders wo ON wo.id = wop."workOrderId"
        JOIN goods g        ON g.id  = wop."goodId"
        WHERE wop."orgId"    = ${orgId}::uuid
          AND wop."deletedAt" IS NULL
          AND wo."orgId"      = ${orgId}::uuid
          AND wo."deletedAt"  IS NULL
          AND wo."status"     = ANY(ARRAY['COMPLETED','INVOICED','PAID','ARCHIVED']::"WorkOrderStatus"[])
          AND wo."completedAt" BETWEEN ${fromDate} AND ${toDate}
      `,
    ]);

    // BR-RPT-023: виручка для прибутку й маржі — БЕЗ ПДВ (ПДВ — не дохід СТО, а податок до
    // сплати); сума з ПДВ і сам ПДВ віддаються окремо.
    const totalRevenue = moneyFromDecimal(woAgg[0]?.totalRevenue);
    const totalRevenueWithVat = moneyFromDecimal(woAgg[0]?.totalRevenueWithVat);
    const ordersCount = Number(woAgg[0]?.ordersCount ?? 0);
    const totalCostParts = moneyFromDecimal(partAgg[0]?.costParts);
    const unknownCostPartsCount = Number(partAgg[0]?.unknownCount ?? 0);
    // Bug #629: totalLabor × LABOR_COST_RATIO (0.4) — множення на дріб дає float-дрейф
    // (3520.30 × 0.4 = 1408.1200000000001; 999.99 × 0.4 = 399.99600000000004), який раніше
    // просочувався сирим у JSON звіту та CSV-експорт «Рентабельність» (page.tsx рядок 620/623).
    // Квантуємо КОЖНЕ похідне грошове значення до копійки (заявлений інваріант Хвилі 3).
    const totalCostLabor = money(moneyFromDecimal(woAgg[0]?.totalLabor) * laborCostRatio);
    const totalCost = money(totalCostParts + totalCostLabor);
    const grossProfit = money(totalRevenue - totalCost);
    const margin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

    return {
      totalRevenue,
      totalVat: money(totalRevenueWithVat - totalRevenue),
      totalRevenueWithVat,
      totalCost,
      totalCostParts,
      totalCostLabor,
      grossProfit,
      margin: Math.round(margin * 100) / 100,
      ordersCount,
      unknownCostPartsCount,
      // BR-RPT-035: застосована частка праці — підпис «Праця (оцінка N%)» бере її звідси.
      laborCostRatio,
      from,
      to,
    };
  }

  /**
   * BR-RPT-030 — звіт P&L (прибутки й збитки) по київських місяцях, метод нарахування, усе в
   * базовій валюті без ПДВ. Виручка й запчастини — той самий відбір нарядів, що «Рентабельність»;
   * зарплата — нарахування періодів COMPUTED / PAID з розподілом за днями; витрати й інші доходи —
   * каса й банк за статтями; курсові різниці — FX_GAIN − FX_LOSS.
   */
  async pnl(orgId: string, from: string, to: string): Promise<PnlReportDto> {
    const { fromDate, toDate } = normalizeDateRange(from, to);
    const months = monthsBetween(from, to);
    if (months.length > PNL_MAX_MONTHS)
      throw new BadRequestException(
        translateError('err.report.periodTooLong', getLocale(), { max: PNL_MAX_MONTHS }),
      );
    const n = months.length;
    const monthIndex = new Map(months.map((m, i) => [m, i]));
    const kyivMonthOf = (d: Date) => monthIndex.get(kyivYmd(d).slice(0, 7)) ?? -1;
    const dateMonthOf = (d: Date) => monthIndex.get(d.toISOString().slice(0, 7)) ?? -1;
    const base = (amountBase: Prisma.Decimal | null, amount: Prisma.Decimal) =>
      moneyFromDecimal(amountBase ?? amount);

    type MonthRevenue = { month: string; revenue: number };
    type MonthParts = { month: string; costParts: number; unknownCount: bigint };

    // пп. 4–6 — за налаштуваннями організації (рішення власника 2026-10-29); недоступні — типові.
    const settings = await this.pnlSettings(orgId);
    const extraExpenseReasons = settings.expenseCashReasons.filter(r => r !== 'EXPENSE');
    const cashFilter: Prisma.CashOperationWhereInput[] = [
      // «Витрата» — завжди, як до появи налаштувань (стаття не перевіряється).
      { direction: 'OUT', reason: 'EXPENSE' },
    ];
    if (extraExpenseReasons.length)
      cashFilter.push({
        direction: 'OUT',
        reason: { in: extraExpenseReasons },
        expenseCategory: { is: { type: 'EXPENSE' } },
      });
    if (settings.incomeCashReasons.length)
      cashFilter.push({
        direction: 'IN',
        reason: { in: settings.incomeCashReasons },
        expenseCategory: { is: { type: 'INCOME' } },
      });
    // п. 5 — повернення підзвіту зменшує витрату своєї статті (без статті — «Без статті»).
    if (nettsAdvanceReturns(settings))
      cashFilter.push({
        direction: 'IN',
        reason: 'ADVANCE_RETURN',
        OR: [{ expenseCategoryId: null }, { expenseCategory: { is: { type: 'EXPENSE' } } }],
      });

    const [revenueRows, partRows, periods, cashOps, bankTxs, fxTxs, categories] = await Promise.all(
      [
        // п. 1 — той самий відбір нарядів, що profitability(), групування за київським місяцем.
        this.prisma.$queryRaw<MonthRevenue[]>`
          SELECT
            to_char("completedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM') AS month,
            COALESCE(SUM("totalNet"), 0)::float AS revenue
          FROM work_orders
          WHERE "orgId"       = ${orgId}::uuid
            AND "deletedAt"   IS NULL
            AND "status"      = ANY(ARRAY['COMPLETED','INVOICED','PAID','ARCHIVED']::"WorkOrderStatus"[])
            AND "completedAt" BETWEEN ${fromDate} AND ${toDate}
          GROUP BY 1
        `,
        // п. 2 — собівартість запчастин тих самих нарядів (Bug #74: batchCostPrice → purchasePrice).
        this.prisma.$queryRaw<MonthParts[]>`
          SELECT
            to_char(wo."completedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM') AS month,
            COALESCE(SUM(
              wop."quantity" * COALESCE(wop."batchCostPrice", g."purchasePrice")
            ), 0)::float AS "costParts",
            COUNT(*) FILTER (WHERE wop."batchCostPrice" IS NULL AND g."purchasePrice" IS NULL) AS "unknownCount"
          FROM work_order_parts wop
          JOIN work_orders wo ON wo.id = wop."workOrderId"
          JOIN goods g        ON g.id  = wop."goodId"
          WHERE wop."orgId"    = ${orgId}::uuid
            AND wop."deletedAt" IS NULL
            AND wo."orgId"      = ${orgId}::uuid
            AND wo."deletedAt"  IS NULL
            AND wo."status"     = ANY(ARRAY['COMPLETED','INVOICED','PAID','ARCHIVED']::"WorkOrderStatus"[])
            AND wo."completedAt" BETWEEN ${fromDate} AND ${toDate}
          GROUP BY 1
        `,
        // п. 4 — періоди, що перетинають звіт; статус і видалення відсіює allocatePayrollByMonth.
        this.prisma.payrollPeriod.findMany({
          where: {
            orgId,
            periodStart: { lte: new Date(`${to}T00:00:00.000Z`) },
            periodEnd: { gte: new Date(`${from}T00:00:00.000Z`) },
          },
          select: {
            periodStart: true,
            periodEnd: true,
            status: true,
            deletedAt: true,
            lines: { select: { accruedAmount: true } },
          },
        }),
        // пп. 5–6 — каса: витрати (OUT за налаштуванням) та інші доходи (IN за налаштуванням зі
        // статтею INCOME). Рядок-сторно (reversalOfId) — не P&L; його оригінал відсіюється нижче.
        this.prisma.cashOperation.findMany({
          where: {
            orgId,
            createdAt: { gte: fromDate, lte: toDate },
            reversalOfId: null,
            OR: cashFilter,
          },
          select: {
            id: true,
            direction: true,
            reason: true,
            amount: true,
            amountBase: true,
            expenseCategoryId: true,
            createdAt: true,
          },
        }),
        // п. 5 — банк: рознесені вихідні витрати за статтею, за датою операції (@db.Date).
        this.prisma.bankTransaction.findMany({
          where: {
            orgId,
            deletedAt: null,
            direction: 'OUT',
            status: 'MATCHED',
            matchedType: 'EXPENSE',
            operationDate: dateOnlyRangeFilter(from, to),
          },
          select: { amount: true, amountBase: true, expenseCategoryId: true, operationDate: true },
        }),
        // п. 7 — курсові різниці. І клієнтська, і постачальницька сторона пишуть FX_GAIN, коли
        // різниця на користь СТО (payments.service / supplier-payments.service) — знак один.
        this.prisma.settlementTransaction.findMany({
          where: {
            orgId,
            type: { in: ['FX_GAIN', 'FX_LOSS'] },
            createdAt: { gte: fromDate, lte: toDate },
          },
          select: { type: true, amount: true, amountBase: true, createdAt: true },
        }),
        // Довідник статей ВКЛЮЧНО з видаленими: минулі операції могли йти за статтею, яку прибрали.
        this.prisma.expenseCategory.findMany({
          where: { orgId },
          select: { id: true, name: true, parentId: true, sortOrder: true },
        }),
      ],
    );

    // Сторнована пара каси не входить: оригінал, на який посилається сторно (навіть пізніше періоду).
    const reversed = cashOps.length
      ? await this.prisma.cashOperation.findMany({
          where: { orgId, reversalOfId: { in: cashOps.map(o => o.id) } },
          select: { reversalOfId: true },
        })
      : [];
    const reversedIds = new Set(reversed.map(r => r.reversalOfId));

    const revenue = Array<number>(n).fill(0);
    for (const r of revenueRows) {
      const i = monthIndex.get(r.month);
      if (i !== undefined) revenue[i] = moneyFromDecimal(r.revenue);
    }
    const partsCost = Array<number>(n).fill(0);
    let unknownCostPartsCount = 0;
    for (const r of partRows) {
      unknownCostPartsCount += Number(r.unknownCount ?? 0);
      const i = monthIndex.get(r.month);
      if (i !== undefined) partsCost[i] = moneyFromDecimal(r.costParts);
    }

    const payroll = allocatePayrollByMonth(
      periods.map(p => ({
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        status: p.status,
        deletedAt: p.deletedAt,
        accrued: sumMoney(p.lines.map(l => moneyFromDecimal(l.accruedAmount))),
      })),
      months,
      from,
      to,
      kyivYmd(new Date()),
      settings.warnFuturePayroll,
    );

    const expenseOwn = new Map<string | null, number[]>();
    const incomeOwn = new Map<string | null, number[]>();
    for (const op of cashOps) {
      if (reversedIds.has(op.id)) continue;
      const i = kyivMonthOf(op.createdAt);
      const amount: number = base(op.amountBase, op.amount);
      // Повернення підзвіту — мінус у витратах своєї статті, не «інший дохід».
      if (op.reason === 'ADVANCE_RETURN')
        addToMonth(expenseOwn, op.expenseCategoryId, i, n, -amount);
      else
        addToMonth(
          op.direction === 'OUT' ? expenseOwn : incomeOwn,
          op.expenseCategoryId,
          i,
          n,
          amount,
        );
    }
    for (const tx of bankTxs) {
      const i = dateMonthOf(tx.operationDate);
      addToMonth(expenseOwn, tx.expenseCategoryId, i, n, base(tx.amountBase, tx.amount));
    }
    const fx = Array<number>(n).fill(0);
    for (const tx of fxTxs) {
      const i = kyivMonthOf(tx.createdAt);
      if (i < 0) continue;
      const sign = tx.type === 'FX_GAIN' ? 1 : -1;
      fx[i] = (fx[i] ?? 0) + sign * base(tx.amountBase, tx.amount);
    }

    const expenseRows = buildCategoryRows(expenseOwn, categories, n);
    const incomeRows = buildCategoryRows(incomeOwn, categories, n);
    const expenses = sumRootRows(expenseRows, n);
    const otherIncome = sumRootRows(incomeRows, n);
    const fxMoney = fx.map(v => money(v));
    const grossProfit = months.map((_, i) => money((revenue[i] ?? 0) - (partsCost[i] ?? 0)));
    // п. 8: чистий = валовий − зарплата − витрати + інші доходи + курсові різниці.
    const netProfit = months.map((_, i) =>
      money(
        (grossProfit[i] ?? 0) -
          (payroll.amounts[i] ?? 0) -
          (expenses[i] ?? 0) +
          (otherIncome[i] ?? 0) +
          (fxMoney[i] ?? 0),
      ),
    );

    const row = (key: PnlRowKey, amounts: number[]): PnlRowDto => ({
      key,
      amounts,
      total: sumMoney(amounts),
    });
    const categoryRow = (key: PnlRowKey, r: PnlCategoryRow): PnlRowDto => ({ key, ...r });

    return {
      months,
      rows: [
        row('revenue', revenue),
        row('partsCost', partsCost),
        row('grossProfit', grossProfit),
        row('payroll', payroll.amounts),
        row('expenses', expenses),
        ...expenseRows.map(r => categoryRow('expenseCategory', r)),
        row('otherIncome', otherIncome),
        ...incomeRows.map(r => categoryRow('incomeCategory', r)),
        row('fx', fxMoney),
        row('netProfit', netProfit),
      ],
      unknownCostPartsCount,
      payrollMissingMonths: payroll.missingMonths,
      settings,
      from,
      to,
    };
  }

  /** Налаштування P&L організації; недоступні (Redis/БД) — типові, звіт не блокуємо. */
  private async pnlSettings(orgId: string): Promise<PnlSettings> {
    try {
      return resolvePnlSettings(await this.settings.getOrganisationSettings(orgId));
    } catch {
      return resolvePnlSettings(null);
    }
  }

  async settlements(orgId: string, counterpartyId?: string) {
    // Bug #607: nested-фільтр counterparty.deletedAt=null — інакше soft-deleted CP
    // (з ненульовим балансом) потрапляє у звіт як клікабельний рядок, який завершується
    // 404 (deletedAt приховує на /counterparties/:id). Узгоджує «Взаєморозрахунки»
    // із `/supplier-payments/schedule`, яка вже має цей фільтр.
    const where: Prisma.SettlementAccountWhereInput = {
      orgId,
      counterparty: { deletedAt: null },
    };
    if (counterpartyId) where.counterpartyId = counterpartyId;

    const accounts = await this.prisma.settlementAccount.findMany({
      where,
      include: {
        counterparty: {
          select: { firstName: true, lastName: true, companyName: true, type: true },
        },
      },
      orderBy: { balance: 'desc' },
      take: 5000,
    });

    const rows = accounts.map(a => ({
      counterpartyId: a.counterpartyId,
      counterpartyName: formatPersonName(
        a.counterparty.lastName,
        a.counterparty.firstName,
        a.counterparty.companyName,
      ),
      type: a.counterparty.type,
      balance: Number(a.balance),
    }));

    return {
      rows,
      // Bug #629: Σ квантованих балансів у JS-float дрейфує — квантуємо підсумки до копійки.
      totalDebit: sumMoney(rows.filter(r => r.balance > 0).map(r => r.balance)),
      totalCredit: sumMoney(rows.filter(r => r.balance < 0).map(r => Math.abs(r.balance))),
    };
  }

  async load(orgId: string, from: string, to: string, branchId?: string) {
    const { fromDate, toDate } = normalizeDateRange(from, to);

    // Parallel: optional branch guard + slot scan + довідник підйомників + робочий час філій
    // (-1 RTT у happy path).
    const [branch, slots, lifts, branchSettings] = await Promise.all([
      branchId
        ? this.prisma.garageBranch.findFirst({
            where: { id: branchId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      this.prisma.calendarSlot.findMany({
        where: {
          orgId,
          deletedAt: null,
          startAt: { gte: fromDate, lte: toDate },
          ...(branchId ? { lift: { zone: { branchId, orgId } } } : {}),
        },
        include: {
          lift: { select: { name: true, zone: { select: { name: true, branchId: true } } } },
        },
        take: 5000,
      }),
      // Підйомники без жодного запису за період теж у звіті (totalSlots = 0): web показує їх одним
      // рядком «Ще N підйомників без записів», а не порожніми стовпчиками (огляд звітів 2026-10-29).
      this.prisma.lift.findMany({
        where: {
          orgId,
          deletedAt: null,
          ...(branchId ? { zone: { is: { branchId, orgId } } } : {}),
        },
        select: { id: true, name: true, zone: { select: { name: true, branchId: true } } },
        take: 500,
      }),
      // BR-RPT-033: місткість підйомника — робочий час його філії (рядків — по одному на філію).
      this.prisma.branchSettings.findMany({
        where: { orgId },
        select: { branchId: true, workStartTime: true, workEndTime: true, workDays: true },
        take: 500,
      }),
    ]);
    if (branchId && !branch)
      throw new NotFoundException(translateError('err.branch.notFound', getLocale()));

    type LiftAgg = {
      liftId: string;
      liftName: string;
      zoneName: string;
      branchId: string | null;
      totalSlots: number;
      totalHours: number;
    };
    const byLift: Record<string, LiftAgg> = {};
    for (const slot of slots) {
      const liftId = slot.liftId;
      if (!liftId) continue;
      if (!byLift[liftId]) {
        byLift[liftId] = {
          liftId,
          liftName: slot.lift?.name ?? 'Невідомий',
          zoneName: slot.lift?.zone?.name ?? '',
          branchId: slot.lift?.zone?.branchId ?? null,
          totalSlots: 0,
          totalHours: 0,
        };
      }
      byLift[liftId].totalSlots++;
      const hours = (slot.endAt.getTime() - slot.startAt.getTime()) / 3_600_000;
      byLift[liftId].totalHours += hours;
    }
    for (const l of lifts) {
      byLift[l.id] ??= {
        liftId: l.id,
        liftName: l.name,
        zoneName: l.zone?.name ?? '',
        branchId: l.zone?.branchId ?? null,
        totalSlots: 0,
        totalHours: 0,
      };
    }

    // Календарні дні періоду, обидва включно. Рахуємо з дат, а не з різниці меж: доба 25.10
    // (переведення годинника) триває 25 годин, і ceil(25 год / 24) давав зайвий день.
    const totalDays =
      Math.round(
        (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
      ) + 1;

    // BR-RPT-033: місткість = робочі дні філії підйомника за період × тривалість її робочого дня;
    // філія без BranchSettings — 09:00–18:00, пн–пт. Одна на філію, не на підйомник.
    const settingsByBranch = new Map(branchSettings.map(b => [b.branchId, b]));
    const capacityByBranch = new Map<string | null, number>();
    const capacityOf = (bId: string | null): number => {
      let c = capacityByBranch.get(bId);
      if (c === undefined) {
        c = workCapacityHours(from, to, bId ? settingsByBranch.get(bId) : null);
        capacityByBranch.set(bId, c);
      }
      return c;
    };

    return {
      rows: Object.values(byLift).map(({ branchId: liftBranchId, ...r }) => {
        const capacityHours = capacityOf(liftBranchId);
        return {
          ...r,
          capacityHours,
          // Один знак після коми: за рік 3 години давали «0%» поруч із підйомником без записів.
          // Період лише з вихідних (місткість 0) → 0 %, а не ділення на нуль.
          loadPercent:
            capacityHours > 0 ? Math.round((r.totalHours / capacityHours) * 1000) / 10 : 0,
        };
      }),
      from,
      to,
      totalDays,
    };
  }

  async vatReport(orgId: string, from: string, to: string) {
    // Order check only; the bounds themselves are calendar dates (see documentDate below).
    normalizeDateRange(from, to);
    // documentDate is a date WITHOUT time (@db.Date): compare calendar dates. Kyiv-midnight
    // bounds (21:00Z of the previous day) pulled the day before `from` into the period.
    const documentDate = dateOnlyRangeFilter(from, to);

    // sto-review §5 Business Rules:
    // (1) Invoices: DRAFT не створює податкове зобов'язання (не виставлений клієнту),
    //     CANCELLED — анульований. До звіту входять усі виставлені: SENT, PARTIALLY_PAID, PAID,
    //     OVERDUE. Без PARTIALLY_PAID часткова оплата прибирала рахунок зі звіту, доки його
    //     не доплатять (Bug #854): зобов'язання з ПДВ виникає з виставлення, а не з оплати.
    // (2) PurchaseOrders: VAT credit виникає лише після фактичної поставки
    //     (RECEIVED/PARTIAL). DRAFT/ORDERED — ще не отримано → немає податкового кредиту.
    const [invoicedAgg, purchasedAgg] = await Promise.all([
      this.prisma.invoice.aggregate({
        where: {
          orgId,
          deletedAt: null,
          status: { in: ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'] },
          documentDate,
        },
        _sum: { totalVat: true },
      }),
      this.prisma.purchaseOrder.aggregate({
        where: {
          orgId,
          deletedAt: null,
          status: { in: ['PARTIAL', 'RECEIVED'] },
          documentDate,
        },
        _sum: { totalVat: true },
      }),
    ]);

    // Prisma _sum.totalVat → `Decimal | null` (per generated client). Direct access без
    // `as { totalVat?: unknown }` cast — типи виводяться коректно.
    const invoiced = moneyFromDecimal(invoicedAgg._sum.totalVat);
    const purchases = moneyFromDecimal(purchasedAgg._sum.totalVat);

    // Bug #629: різниця двох грошових сум у JS-float дрейфує (100.10−33.33=66.77000000000001) —
    // квантуємо чисте ПДВ до копійки перед поверненням у звіт/експорт.
    return { invoiced, purchases, net: money(invoiced - purchases), from, to };
  }
}
