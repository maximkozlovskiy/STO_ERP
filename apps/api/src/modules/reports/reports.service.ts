import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async revenue(orgId: string, from: string, to: string, branchId?: string) {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);

    const where: {
      orgId: string; deletedAt: null;
      status: { in: string[] };
      completedAt: { gte: Date; lte: Date };
      branchId?: string;
    } = {
      orgId,
      deletedAt: null,
      status: { in: ['COMPLETED', 'INVOICED', 'PAID', 'ARCHIVED'] },
      completedAt: { gte: fromDate, lte: toDate },
    };
    if (branchId) where.branchId = branchId;

    const orders = await this.prisma.workOrder.findMany({
      where,
      select: { completedAt: true, totalAmount: true, totalLabor: true, totalParts: true },
      orderBy: { completedAt: 'asc' },
    });

    // Group by date
    const byDate: Record<string, { date: string; revenue: number; labor: number; parts: number; count: number }> = {};
    for (const wo of orders) {
      const date = wo.completedAt!.toISOString().slice(0, 10);
      if (!byDate[date]) byDate[date] = { date, revenue: 0, labor: 0, parts: 0, count: 0 };
      byDate[date].revenue += Number(wo.totalAmount);
      byDate[date].labor += Number(wo.totalLabor);
      byDate[date].parts += Number(wo.totalParts);
      byDate[date].count++;
    }

    const rows = Object.values(byDate);
    const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
    const totalOrders = rows.reduce((s, r) => s + r.count, 0);

    return { rows, totalRevenue, totalOrders, from, to };
  }

  async workOrders(orgId: string, from: string, to: string, employeeId?: string) {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);

    const lineWhere: {
      orgId: string; deletedAt: null;
      workOrder: { deletedAt: null; createdAt: { gte: Date; lte: Date } };
      employeeId?: string;
    } = {
      orgId,
      deletedAt: null,
      workOrder: { deletedAt: null, createdAt: { gte: fromDate, lte: toDate } },
    };
    if (employeeId) lineWhere.employeeId = employeeId;

    const lines = await this.prisma.workOrderLine.findMany({
      where: lineWhere,
      include: {
        employee: { select: { firstName: true, lastName: true } },
        workOrder: { select: { number: true, status: true } },
      },
    });

    // Aggregate by employee
    const byEmp: Record<string, { employeeId: string; employeeName: string; totalNormoHours: number; totalAmount: number; linesCount: number }> = {};
    for (const line of lines) {
      const empId = line.employeeId;
      if (!byEmp[empId]) {
        byEmp[empId] = {
          employeeId: empId,
          employeeName: [line.employee.lastName, line.employee.firstName].filter(Boolean).join(' '),
          totalNormoHours: 0,
          totalAmount: 0,
          linesCount: 0,
        };
      }
      byEmp[empId].totalNormoHours += line.normoHours;
      byEmp[empId].totalAmount += Number(line.amount);
      byEmp[empId].linesCount++;
    }

    return {
      rows: Object.values(byEmp),
      totalNormoHours: lines.reduce((s, l) => s + l.normoHours, 0),
      totalAmount: lines.reduce((s, l) => s + Number(l.amount), 0),
      from, to,
    };
  }

  async stock(orgId: string, warehouseId?: string, from?: string, to?: string) {
    const stockWhere: { orgId: string; warehouseId?: string } = { orgId };
    if (warehouseId) stockWhere.warehouseId = warehouseId;

    const stockItems = await this.prisma.stockItem.findMany({
      where: stockWhere,
      include: {
        good: { select: { name: true, sku: true, unit: true, salePrice: true } },
        warehouse: { select: { name: true } },
      },
      orderBy: [{ warehouse: { name: 'asc' } }, { good: { name: 'asc' } }],
    });

    const movWhere: { orgId: string; warehouseId?: string; createdAt?: { gte?: Date; lte?: Date } } = { orgId };
    if (warehouseId) movWhere.warehouseId = warehouseId;
    if (from) movWhere.createdAt = { gte: new Date(from) };
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      movWhere.createdAt = { ...movWhere.createdAt, lte: toDate };
    }

    const movements = await this.prisma.stockMovement.findMany({
      where: movWhere,
      include: { good: { select: { name: true, sku: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

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

  async settlements(orgId: string, counterpartyId?: string) {
    const where: { orgId: string; counterpartyId?: string } = { orgId };
    if (counterpartyId) where.counterpartyId = counterpartyId;

    const accounts = await this.prisma.settlementAccount.findMany({
      where,
      include: {
        counterparty: { select: { firstName: true, lastName: true, companyName: true, type: true } },
      },
      orderBy: { balance: 'desc' },
    });

    const rows = accounts.map(a => ({
      counterpartyId: a.counterpartyId,
      counterpartyName: a.counterparty.companyName ??
        [a.counterparty.lastName, a.counterparty.firstName].filter(Boolean).join(' '),
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
    const fromDate = new Date(from);
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);

    const slotsWhere: { orgId: string; deletedAt: null; startAt: { gte: Date; lte: Date } } = {
      orgId,
      deletedAt: null,
      startAt: { gte: fromDate, lte: toDate },
    };

    const slots = await this.prisma.calendarSlot.findMany({
      where: slotsWhere,
      include: {
        lift: { select: { name: true, zone: { select: { name: true, branchId: true } } } },
      },
    });

    const filtered = branchId
      ? slots.filter(s => s.lift?.zone?.branchId === branchId)
      : slots;

    // Aggregate by lift
    const byLift: Record<string, { liftId: string | null; liftName: string; zoneName: string; totalSlots: number; totalHours: number }> = {};
    for (const slot of filtered) {
      const liftId = slot.liftId;
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
    const workHoursPerDay = 9; // 09:00–18:00

    return {
      rows: Object.values(byLift).map((r) => ({
        ...r,
        loadPercent: Math.round((r.totalHours / (totalDays * workHoursPerDay)) * 100),
      })),
      from, to, totalDays,
    };
  }
}
