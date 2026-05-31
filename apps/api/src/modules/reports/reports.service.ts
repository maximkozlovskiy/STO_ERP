import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { formatPersonName } from '@sto/shared';

// Module-level Intl singleton — locale-data init is the dominant cost; both
// normalizeDateRange branches and report calls go through kyivOffsetMs.
const KYIV_HOUR_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv',
  hour: '2-digit',
  hour12: false,
});

function kyivOffsetMs(d: Date): number {
  const kyivHour = parseInt(KYIV_HOUR_FMT.format(d), 10);
  const utcHour = d.getUTCHours();
  return ((kyivHour - utcHour + 24) % 24) * 3_600_000;
}

function normalizeDateRange(from: string, to: string) {
  const fromMidnight = new Date(`${from}T00:00:00Z`);
  const toEndOfDay = new Date(`${to}T23:59:59.999Z`);
  const fromDate = new Date(fromMidnight.getTime() - kyivOffsetMs(fromMidnight));
  const toDate = new Date(toEndOfDay.getTime() - kyivOffsetMs(toEndOfDay));
  if (fromDate > toDate)
    throw new BadRequestException('Дата початку має бути не пізніше дати закінчення');
  return { fromDate, toDate };
}

const WORK_HOURS_PER_DAY = 9;

// Module-level Intl singletons — locale-data init coштує найбільше у форматерах.
// Hot path: revenue() цикл до 10 000 рядків; уникаємо створення форматера на кожен виклик.
const KYIV_DATE_FMT = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });

/**
 * Labor cost ratio (mechanic salary as fraction of labor revenue).
 * 0.4 = 40% — typical for Ukraine SMB auto-services where salary fund is ~40% of labor income.
 * TODO: move to OrganisationSettings.laborCostRatio for per-org configuration.
 */
const LABOR_COST_RATIO = 0.4;

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async revenue(orgId: string, from: string, to: string, branchId?: string) {
    const { fromDate, toDate } = normalizeDateRange(from, to);

    if (branchId) {
      const branch = await this.prisma.garageBranch.findFirst({
        where: { id: branchId, orgId, deletedAt: null },
      });
      if (!branch) throw new NotFoundException('Філію не знайдено');
    }

    // DB-side aggregation via DATE_TRUNC at Europe/Kyiv — раніше findMany(take:10000)
    // тягнув повний набір рядків і робив JS reduce у циклі. Тепер Postgres віддає
    // ~30 рядків (по одному на день) безпосередньо у потрібному форматі.
    type RevenueRow = {
      date: Date;
      revenue: number;
      labor: number;
      parts: number;
      count: number;
    };
    const rows = await this.prisma.$queryRaw<RevenueRow[]>`
      SELECT
        DATE_TRUNC('day', "completedAt" AT TIME ZONE 'Europe/Kyiv') AS date,
        COALESCE(SUM("totalAmount"), 0)::float AS revenue,
        COALESCE(SUM("totalLabor"),  0)::float AS labor,
        COALESCE(SUM("totalParts"),  0)::float AS parts,
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
    `;

    // Convert raw rows to API shape; формат `YYYY-MM-DD` через Kyiv-формaтер
    // зберігається ідентичний до попередньої версії.
    const result = rows.map(r => ({
      date: KYIV_DATE_FMT.format(r.date),
      revenue: Number(r.revenue),
      labor: Number(r.labor),
      parts: Number(r.parts),
      count: Number(r.count),
    }));

    const totalRevenue = result.reduce((s, r) => s + r.revenue, 0);
    const totalOrders = result.reduce((s, r) => s + r.count, 0);

    return { rows: result, totalRevenue, totalOrders, from, to };
  }

  async workOrders(orgId: string, from: string, to: string, employeeId?: string) {
    const { fromDate, toDate } = normalizeDateRange(from, to);

    if (employeeId) {
      const emp = await this.prisma.employee.findFirst({
        where: { id: employeeId, orgId, deletedAt: null },
      });
      if (!emp) throw new NotFoundException('Співробітника не знайдено');
    }

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
    const rows = await this.prisma.$queryRaw<GroupRow[]>`
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
        AND wo."createdAt"   BETWEEN ${fromDate} AND ${toDate}
        ${employeeId ? Prisma.sql`AND wol."employeeId" = ${employeeId}::uuid` : Prisma.empty}
      GROUP BY wol."employeeId", e."firstName", e."lastName"
      ORDER BY "totalAmount" DESC
    `;

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
      totalAmount: result.reduce((s, r) => s + r.totalAmount, 0),
      from,
      to,
    };
  }

  async stock(orgId: string, warehouseId?: string, from?: string, to?: string) {
    if (warehouseId) {
      const wh = await this.prisma.warehouse.findFirst({
        where: { id: warehouseId, orgId, deletedAt: null },
      });
      if (!wh) throw new NotFoundException('Склад не знайдено');
    }

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
    if (from) {
      const d = new Date(`${from}T00:00:00Z`);
      movWhere.createdAt = { gte: new Date(d.getTime() - kyivOffsetMs(d)) };
    }
    if (to) {
      const d = new Date(`${to}T23:59:59.999Z`);
      movWhere.createdAt = { ...movWhere.createdAt, lte: new Date(d.getTime() - kyivOffsetMs(d)) };
    }

    // Parallel: stockItems and stockMovements are independent queries on different tables.
    const [stockItems, movements] = await Promise.all([
      this.prisma.stockItem.findMany({
        where: stockWhere,
        include: {
          good: { select: { name: true, sku: true, unit: true, salePrice: true } },
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
    ]);

    return {
      stockItems: stockItems.map(i => ({
        goodId: i.goodId,
        goodName: i.good.name,
        goodSku: i.good.sku,
        unit: i.good.unit,
        warehouseName: i.warehouse.name,
        quantity: i.quantity,
        reserved: i.reserved,
        available: i.quantity - i.reserved,
        value: i.quantity * Number(i.good.salePrice),
      })),
      movements: movements.map(m => ({
        type: m.type,
        goodName: m.good.name,
        quantity: m.quantity,
        documentType: m.documentType,
        createdAt: m.createdAt,
      })),
      totalValue: stockItems.reduce((s, i) => s + i.quantity * Number(i.good.salePrice), 0),
    };
  }

  async profitability(orgId: string, from: string, to: string) {
    const { fromDate, toDate } = normalizeDateRange(from, to);

    type WOAgg = { totalRevenue: number; totalLabor: number; ordersCount: bigint };
    type PartAgg = { costParts: number; unknownCount: bigint };

    // Two aggregation queries instead of loading up to 10 000 orders × 500 parts each.
    const [woAgg, partAgg] = await Promise.all([
      // Aggregate revenue + labor from work orders
      this.prisma.$queryRaw<WOAgg[]>`
        SELECT
          COALESCE(SUM("totalAmount"), 0)::float AS "totalRevenue",
          COALESCE(SUM("totalLabor"),  0)::float AS "totalLabor",
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

    const totalRevenue = Number(woAgg[0]?.totalRevenue ?? 0);
    const ordersCount = Number(woAgg[0]?.ordersCount ?? 0);
    const totalCostParts = Number(partAgg[0]?.costParts ?? 0);
    const unknownCostPartsCount = Number(partAgg[0]?.unknownCount ?? 0);
    const totalCostLabor = Number(woAgg[0]?.totalLabor ?? 0) * LABOR_COST_RATIO;
    const totalCost = totalCostParts + totalCostLabor;
    const grossProfit = totalRevenue - totalCost;
    const margin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

    return {
      totalRevenue,
      totalCost,
      totalCostParts,
      totalCostLabor,
      grossProfit,
      margin: Math.round(margin * 100) / 100,
      ordersCount,
      unknownCostPartsCount,
      from,
      to,
    };
  }

  async settlements(orgId: string, counterpartyId?: string) {
    const where: { orgId: string; counterpartyId?: string } = { orgId };
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
      totalDebit: rows.filter(r => r.balance > 0).reduce((s, r) => s + r.balance, 0),
      totalCredit: rows.filter(r => r.balance < 0).reduce((s, r) => s + Math.abs(r.balance), 0),
    };
  }

  async load(orgId: string, from: string, to: string, branchId?: string) {
    const { fromDate, toDate } = normalizeDateRange(from, to);

    if (branchId) {
      const branch = await this.prisma.garageBranch.findFirst({
        where: { id: branchId, orgId, deletedAt: null },
      });
      if (!branch) throw new NotFoundException('Філію не знайдено');
    }

    const slots = await this.prisma.calendarSlot.findMany({
      where: {
        orgId,
        deletedAt: null,
        startAt: { gte: fromDate, lte: toDate },
        ...(branchId ? { lift: { zone: { branchId, orgId } } } : {}),
      },
      include: {
        lift: { select: { name: true, zone: { select: { name: true } } } },
      },
      take: 5000,
    });

    // Aggregate by lift
    const byLift: Record<
      string,
      { liftId: string; liftName: string; zoneName: string; totalSlots: number; totalHours: number }
    > = {};
    for (const slot of slots) {
      const liftId = slot.liftId;
      if (!liftId) continue;
      if (!byLift[liftId]) {
        byLift[liftId] = {
          liftId,
          liftName: slot.lift?.name ?? 'Невідомий',
          zoneName: slot.lift?.zone?.name ?? '',
          totalSlots: 0,
          totalHours: 0,
        };
      }
      byLift[liftId].totalSlots++;
      const hours = (slot.endAt.getTime() - slot.startAt.getTime()) / 3_600_000;
      byLift[liftId].totalHours += hours;
    }

    const totalDays = Math.max(1, Math.ceil((toDate.getTime() - fromDate.getTime()) / 86_400_000));

    return {
      rows: Object.values(byLift).map(r => ({
        ...r,
        loadPercent: Math.round((r.totalHours / (totalDays * WORK_HOURS_PER_DAY)) * 100),
      })),
      from,
      to,
      totalDays,
    };
  }
}
