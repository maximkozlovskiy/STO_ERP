import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma, WorkOrderStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { formatPersonName } from '@sto/shared';

function normalizeDateRange(from: string, to: string) {
  const fromDate = new Date(`${from}T00:00:00+03:00`);
  const toDate = new Date(`${to}T23:59:59.999+03:00`);
  if (fromDate > toDate) throw new BadRequestException('Дата початку має бути не пізніше дати закінчення');
  return { fromDate, toDate };
}

const WORK_HOURS_PER_DAY = 9;

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async revenue(orgId: string, from: string, to: string, branchId?: string) {
    const { fromDate, toDate } = normalizeDateRange(from, to);

    if (branchId) {
      const branch = await this.prisma.garageBranch.findFirst({ where: { id: branchId, orgId, deletedAt: null } });
      if (!branch) throw new NotFoundException('Філію не знайдено');
    }

    const where: Prisma.WorkOrderWhereInput = {
      orgId,
      deletedAt: null,
      status: { in: ['COMPLETED', 'INVOICED', 'PAID', 'ARCHIVED'] as WorkOrderStatus[] },
      completedAt: { gte: fromDate, lte: toDate },
    };
    if (branchId) where.branchId = branchId;

    const orders = await this.prisma.workOrder.findMany({
      where,
      select: { completedAt: true, totalAmount: true, totalLabor: true, totalParts: true },
      orderBy: { completedAt: 'asc' },
    });

    const kyivDate = (d: Date) =>
      new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(d);

    // Group by date
    const byDate: Record<string, { date: string; revenue: number; labor: number; parts: number; count: number }> = {};
    for (const wo of orders) {
      const date = kyivDate(wo.completedAt!);
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
    const { fromDate, toDate } = normalizeDateRange(from, to);

    if (employeeId) {
      const emp = await this.prisma.employee.findFirst({ where: { id: employeeId, orgId, deletedAt: null } });
      if (!emp) throw new NotFoundException('Співробітника не знайдено');
    }

    const lineWhere: {
      orgId: string; deletedAt: null;
      workOrder: { orgId: string; deletedAt: null; createdAt: { gte: Date; lte: Date } };
      employeeId?: string;
    } = {
      orgId,
      deletedAt: null,
      workOrder: { orgId, deletedAt: null, createdAt: { gte: fromDate, lte: toDate } },
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
          employeeName: formatPersonName(line.employee.lastName, line.employee.firstName),
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
    if (warehouseId) {
      const wh = await this.prisma.warehouse.findFirst({ where: { id: warehouseId, orgId, deletedAt: null } });
      if (!wh) throw new NotFoundException('Склад не знайдено');
    }

    const stockWhere: { orgId: string; warehouseId?: string; deletedAt: null } = { orgId, deletedAt: null };
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
    if (from) movWhere.createdAt = { gte: new Date(`${from}T00:00:00+03:00`) };
    if (to) movWhere.createdAt = { ...movWhere.createdAt, lte: new Date(`${to}T23:59:59.999+03:00`) };

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
    const where: { orgId: string; counterpartyId?: string; deletedAt: null } = { orgId, deletedAt: null };
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
      counterpartyName: formatPersonName(a.counterparty.lastName, a.counterparty.firstName, a.counterparty.companyName),
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
      const branch = await this.prisma.garageBranch.findFirst({ where: { id: branchId, orgId, deletedAt: null } });
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
    });

    // Aggregate by lift
    const byLift: Record<string, { liftId: string; liftName: string; zoneName: string; totalSlots: number; totalHours: number }> = {};
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
      rows: Object.values(byLift).map((r) => ({
        ...r,
        loadPercent: Math.round((r.totalHours / (totalDays * WORK_HOURS_PER_DAY)) * 100),
      })),
      from, to, totalDays,
    };
  }
}
