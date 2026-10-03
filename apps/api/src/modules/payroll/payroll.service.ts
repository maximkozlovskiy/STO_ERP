import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS, formatPersonName, translateError } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { getLocale } from '../../common/tenant/tenant-context';
import { AuditService } from '../audit/audit.service';
import { CashService } from '../cash/cash.service';
import { money, moneyFromDecimal, sumMoney } from '../../common/utils/money';
import { calculatePagination } from '../../common/utils/pagination';
import { computeAccrued, parseRateScheme } from './payroll.calculator';
import {
  CreatePayrollPeriodDto,
  PaginatedPayrollPeriodsDto,
  type PayrollPeriodStatus,
  PayrollLineDto,
  PayrollLineWorkOrderDto,
  PayrollPeriodResponseDto,
  PayrollPreviewDto,
} from './payroll.dto';

// Kyiv-aware межі дат (дзеркалить reports.service.normalizeDateRange).
const KYIV_HOUR_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv',
  hour: '2-digit',
  hour12: false,
});
function kyivOffsetMs(d: Date): number {
  const kyivHour = parseInt(KYIV_HOUR_FMT.format(d), 10);
  return ((kyivHour - d.getUTCHours() + 24) % 24) * 3_600_000;
}
function normalizeDateRange(from: string, to: string) {
  const fromMidnight = new Date(`${from}T00:00:00Z`);
  const toEndOfDay = new Date(`${to}T23:59:59.999Z`);
  const fromDate = new Date(fromMidnight.getTime() - kyivOffsetMs(fromMidnight));
  const toDate = new Date(toEndOfDay.getTime() - kyivOffsetMs(toEndOfDay));
  if (fromDate > toDate)
    throw new BadRequestException(translateError('err.payroll.startAfterEnd', getLocale()));
  return { fromDate, toDate };
}

// Агрегований виробіток співробітника за завершеними роботами періоду.
interface WorkAggRow {
  employeeId: string;
  firstName: string;
  lastName: string;
  rateScheme: Prisma.JsonValue;
  totalNormoHours: number;
  totalAmount: number;
  linesCount: bigint;
}

// Розшифровка виробітку співробітника по нарядах (для snapshot розбивки нарахування).
interface WorkOrderAggRow {
  employeeId: string;
  workOrderId: string;
  workOrderNumber: string;
  make: string | null;
  model: string | null;
  licensePlate: string | null;
  worksCount: bigint;
  normoHours: number;
  baseAmount: number;
}

// «Toyota Camry · AA1234BB» / «Toyota Camry» / «AA1234BB» / null — snapshot назви авто.
function formatVehicleName(
  make: string | null,
  model: string | null,
  plate: string | null,
): string | null {
  const name = [make, model].filter(Boolean).join(' ').trim();
  const p = plate?.trim();
  if (name && p) return `${name} · ${p}`;
  return name || p || null;
}

@Injectable()
export class PayrollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cash: CashService,
  ) {}

  /**
   * Агрегує виробіток по співробітниках за ЗАВЕРШЕНИМИ роботами періоду й рахує нарахування.
   * Джерело: work_order_lines, де наряд у статусі COMPLETED/INVOICED/PAID/ARCHIVED і completedAt-у-періоді
   * (логіка revenue(), НЕ workOrders()). Рахує лише primary employeeId (асистенти — поза v1).
   */
  private async aggregate(
    orgId: string,
    fromDate: Date,
    toDate: Date,
    branchId?: string,
  ): Promise<PayrollLineDto[]> {
    if (branchId) {
      const branch = await this.prisma.garageBranch.findFirst({
        where: { id: branchId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!branch) throw new NotFoundException(translateError('err.branch.notFound', getLocale()));
    }

    const rows = await this.prisma.$queryRaw<WorkAggRow[]>`
      SELECT
        wol."employeeId",
        e."firstName",
        e."lastName",
        e."rateScheme",
        COALESCE(SUM(wol."normoHours"), 0)::float AS "totalNormoHours",
        COALESCE(SUM(wol."amount"), 0)::float     AS "totalAmount",
        COUNT(*)                                   AS "linesCount"
      FROM work_order_lines wol
      JOIN work_orders wo ON wo.id = wol."workOrderId"
      JOIN employees e    ON e.id  = wol."employeeId"
      WHERE wol."orgId"     = ${orgId}::uuid
        AND wol."deletedAt" IS NULL
        AND wo."orgId"      = ${orgId}::uuid
        AND wo."deletedAt"  IS NULL
        AND e."deletedAt"   IS NULL
        AND wo."status"     = ANY(ARRAY['COMPLETED','INVOICED','PAID','ARCHIVED']::"WorkOrderStatus"[])
        AND wo."completedAt" >= ${fromDate}
        AND wo."completedAt" <= ${toDate}
        ${branchId ? Prisma.sql`AND wo."branchId" = ${branchId}::uuid` : Prisma.empty}
      GROUP BY wol."employeeId", e."firstName", e."lastName", e."rateScheme"
      ORDER BY "totalAmount" DESC
    `;

    return rows.map(r => {
      const scheme = parseRateScheme(r.rateScheme);
      const baseAmount = money(r.totalAmount); // ::float у SQL → вже number
      const normoHours = Number(r.totalNormoHours);
      return {
        employeeId: r.employeeId,
        employeeName: formatPersonName(r.lastName, r.firstName),
        rateSchemeType: scheme?.type ?? 'unknown',
        baseAmount,
        normoHours,
        linesCount: Number(r.linesCount),
        accruedAmount: computeAccrued(scheme, { baseAmount, normoHours }),
      };
    });
  }

  /**
   * Розшифровка виробітку по нарядах (для кожного співробітника) за той самий період/фільтр, що й
   * aggregate(). Групування GROUP BY employeeId, workOrderId — по одному рядку на наряд.
   * Повертає Map<employeeId, WorkOrderAggRow[]> (для snapshot розбивки при compute()).
   */
  private async aggregateWorkOrders(
    orgId: string,
    fromDate: Date,
    toDate: Date,
    branchId?: string,
  ): Promise<Map<string, WorkOrderAggRow[]>> {
    const rows = await this.prisma.$queryRaw<WorkOrderAggRow[]>`
      SELECT
        wol."employeeId",
        wo.id                                      AS "workOrderId",
        wo."number"                                AS "workOrderNumber",
        v."make",
        v."model",
        v."licensePlate",
        COUNT(*)                                   AS "worksCount",
        COALESCE(SUM(wol."normoHours"), 0)::float  AS "normoHours",
        COALESCE(SUM(wol."amount"), 0)::float      AS "baseAmount"
      FROM work_order_lines wol
      JOIN work_orders wo  ON wo.id = wol."workOrderId"
      LEFT JOIN vehicles v ON v.id  = wo."vehicleId"
      WHERE wol."orgId"     = ${orgId}::uuid
        AND wol."deletedAt" IS NULL
        AND wo."orgId"      = ${orgId}::uuid
        AND wo."deletedAt"  IS NULL
        AND wo."status"     = ANY(ARRAY['COMPLETED','INVOICED','PAID','ARCHIVED']::"WorkOrderStatus"[])
        AND wo."completedAt" >= ${fromDate}
        AND wo."completedAt" <= ${toDate}
        ${branchId ? Prisma.sql`AND wo."branchId" = ${branchId}::uuid` : Prisma.empty}
      GROUP BY wol."employeeId", wo.id, wo."number", v."make", v."model", v."licensePlate"
      ORDER BY "baseAmount" DESC
    `;
    const byEmployee = new Map<string, WorkOrderAggRow[]>();
    for (const r of rows) {
      const list = byEmployee.get(r.employeeId) ?? [];
      list.push(r);
      byEmployee.set(r.employeeId, list);
    }
    return byEmployee;
  }

  /** Попередній розрахунок (без збереження). */
  async preview(
    orgId: string,
    from: string,
    to: string,
    branchId?: string,
  ): Promise<PayrollPreviewDto> {
    const { fromDate, toDate } = normalizeDateRange(from, to);
    const lines = await this.aggregate(orgId, fromDate, toDate, branchId);
    const totalAccrued = sumMoney(lines.map(l => l.accruedAmount));
    return { lines, totalAccrued, from, to };
  }

  /**
   * Сторінка періодів. `lines` НЕ несуть workOrders (важко) — drill-down тягне їх через findOne.
   * Фільтр статусу + пагінація: список росте щомісяця, плоский take:500 не тримає UI.
   */
  async findAll(
    orgId: string,
    page = 1,
    limit = 20,
    status?: PayrollPeriodStatus,
  ): Promise<PaginatedPayrollPeriodsDto> {
    const where: Prisma.PayrollPeriodWhereInput = { orgId, deletedAt: null };
    if (status) where.status = status;
    const { skip, take } = calculatePagination({ page, limit });
    const [periods, total] = await Promise.all([
      this.prisma.payrollPeriod.findMany({
        where,
        include: {
          lines: { include: { employee: { select: { firstName: true, lastName: true } } } },
        },
        // createdAt — первинний ключ сортування (конвенція документних списків проєкту,
        // пор. buildSortOrderBy fallback='createdAt'): щойно створений період ЗАВЖДИ на 1-й
        // сторінці, навіть якщо його periodStart у минулому (перерахунок старого місяця).
        orderBy: [{ createdAt: 'desc' }, { periodStart: 'desc' }],
        skip,
        take,
      }),
      this.prisma.payrollPeriod.count({ where }),
    ]);
    // page віддаємо НОРМАЛІЗОВАНИЙ (похідний від skip/take), а не сире query-значення:
    // інакше при page=0/-5 клієнт отримує skip=0 але page=-5 → Pagination малює хибний стан.
    return { items: periods.map(p => this.toDto(p)), total, page: skip / take + 1, limit: take };
  }

  /** Один період з ПОВНОЮ розшифровкою нарахувань по нарядах (findAll її не вантажить — важко). */
  async findOne(orgId: string, id: string): Promise<PayrollPeriodResponseDto> {
    const period = await this.prisma.payrollPeriod.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        lines: {
          include: {
            employee: { select: { firstName: true, lastName: true } },
            workOrders: { orderBy: { baseAmount: 'desc' } },
          },
        },
      },
    });
    if (!period)
      throw new NotFoundException(translateError('err.payroll.periodNotFound', getLocale()));
    return this.toDto(period);
  }

  async create(
    orgId: string,
    dto: CreatePayrollPeriodDto,
    userId?: string,
  ): Promise<PayrollPeriodResponseDto> {
    // Валідація діапазону (кидає BadRequest якщо from > to).
    normalizeDateRange(dto.periodStart, dto.periodEnd);
    if (dto.branchId) {
      const branch = await this.prisma.garageBranch.findFirst({
        where: { id: dto.branchId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!branch) throw new NotFoundException(translateError('err.branch.notFound', getLocale()));
    }
    const period = await this.prisma.payrollPeriod.create({
      data: {
        orgId,
        branchId: dto.branchId ?? null,
        periodStart: new Date(`${dto.periodStart}T00:00:00Z`),
        periodEnd: new Date(`${dto.periodEnd}T00:00:00Z`),
        note: dto.note ?? null,
        status: 'DRAFT',
      },
      include: { lines: true },
    });
    if (userId) {
      this.audit
        .record(orgId, 'PayrollPeriod', period.id, 'CREATE', userId, undefined, {
          periodStart: dto.periodStart,
          periodEnd: dto.periodEnd,
        })
        .catch(() => undefined);
    }
    return this.toDto(period);
  }

  /** DRAFT → COMPUTED: рахує та ФІКСУЄ нарахування у PayrollLine[] (snapshot). Atomic claim. */
  async compute(orgId: string, id: string, userId?: string): Promise<PayrollPeriodResponseDto> {
    const period = await this.prisma.payrollPeriod.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, status: true, periodStart: true, periodEnd: true, branchId: true },
    });
    if (!period)
      throw new NotFoundException(translateError('err.payroll.periodNotFound', getLocale()));
    if (period.status !== 'DRAFT')
      throw new BadRequestException(translateError('err.payroll.onlyDraftCalculable', getLocale()));

    const fromStr = period.periodStart.toISOString().slice(0, 10);
    const toStr = period.periodEnd.toISOString().slice(0, 10);
    const { fromDate, toDate } = normalizeDateRange(fromStr, toStr);
    const lines = await this.aggregate(orgId, fromDate, toDate, period.branchId ?? undefined);
    // Розбивка виробітку по нарядах (snapshot розшифровки нарахувань).
    const woByEmployee = await this.aggregateWorkOrders(
      orgId,
      fromDate,
      toDate,
      period.branchId ?? undefined,
    );

    await this.prisma.$transaction(
      async tx => {
        // Атомарний claim: лише DRAFT → COMPUTED (переможець гонки — count===1).
        const claim = await tx.payrollPeriod.updateMany({
          where: { id, orgId, status: 'DRAFT' },
          data: { status: 'COMPUTED', computedAt: new Date(), computedBy: userId ?? null },
        });
        if (claim.count === 0)
          throw new BadRequestException(
            translateError('err.payroll.calculateConcurrentChange', getLocale()),
          );
        // Фіксуємо рядки (перестворюємо на випадок повторного DRAFT після скидання — тут DRAFT гарантований).
        // Спершу видаляємо дочірню розшифровку (FK RESTRICT), потім самі рядки.
        const oldLines = await tx.payrollLine.findMany({
          where: { orgId, periodId: id },
          select: { id: true },
        });
        if (oldLines.length > 0) {
          await tx.payrollLineWorkOrder.deleteMany({
            where: { orgId, payrollLineId: { in: oldLines.map(l => l.id) } },
          });
        }
        await tx.payrollLine.deleteMany({ where: { orgId, periodId: id } });
        if (lines.length > 0) {
          // createMany не повертає id — створюємо рядки по одному, щоб отримати lineId для розшифровки.
          for (const l of lines) {
            const created = await tx.payrollLine.create({
              data: {
                orgId,
                periodId: id,
                employeeId: l.employeeId,
                rateSchemeType: l.rateSchemeType,
                baseAmount: l.baseAmount,
                normoHours: l.normoHours,
                linesCount: l.linesCount,
                accruedAmount: l.accruedAmount,
              },
              select: { id: true },
            });
            const wos = woByEmployee.get(l.employeeId) ?? [];
            if (wos.length > 0) {
              await tx.payrollLineWorkOrder.createMany({
                data: wos.map(w => ({
                  orgId,
                  payrollLineId: created.id,
                  workOrderId: w.workOrderId,
                  workOrderNumber: w.workOrderNumber,
                  vehicleName: formatVehicleName(w.make, w.model, w.licensePlate),
                  worksCount: Number(w.worksCount),
                  normoHours: Number(w.normoHours),
                  baseAmount: money(w.baseAmount), // ::float у SQL → вже number
                })),
              });
            }
          }
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    if (userId) {
      this.audit
        .record(orgId, 'PayrollPeriod', id, 'UPDATE', userId, undefined, {
          computed: true,
          linesCount: lines.length,
        })
        .catch(() => undefined);
    }
    return this.findOne(orgId, id);
  }

  /**
   * COMPUTED → PAID: фіксує виплату (paidAmount = accruedAmount по всіх рядках).
   * Якщо передано cashRegisterId — проводить видачу готівки з каси (cash-out reason=PAYROLL) на кожного
   * співробітника у ту саму транзакцію. Без cashRegisterId — лише фіксація факту (без руху каси).
   */
  async pay(
    orgId: string,
    id: string,
    userId?: string,
    cashRegisterId?: string,
  ): Promise<PayrollPeriodResponseDto> {
    const period = await this.prisma.payrollPeriod.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!period)
      throw new NotFoundException(translateError('err.payroll.periodNotFound', getLocale()));
    if (period.status !== 'COMPUTED')
      throw new BadRequestException(
        translateError('err.payroll.onlyCalculatedPayable', getLocale()),
      );

    // Рядки нарахувань (для cash-out по кожному співробітнику). take: 1 рядок = 1 співробітник періоду
    // (обмежено штатом org), але явний cap як захист від OOM (§3.2).
    const lines = await this.prisma.payrollLine.findMany({
      where: { orgId, periodId: id },
      select: { employeeId: true, accruedAmount: true },
      take: 1000,
    });

    await this.prisma.$transaction(
      async tx => {
        const claim = await tx.payrollPeriod.updateMany({
          where: { id, orgId, status: 'COMPUTED' },
          data: { status: 'PAID', paidAt: new Date(), paidBy: userId ?? null },
        });
        if (claim.count === 0)
          throw new BadRequestException(
            translateError('err.payroll.payConcurrentChange', getLocale()),
          );
        // paidAmount ← accruedAmount (повна виплата нарахованого).
        await tx.$executeRaw`
        UPDATE payroll_lines SET "paidAmount" = "accruedAmount", "updatedAt" = now()
        WHERE "orgId" = ${orgId}::uuid AND "periodId" = ${id}::uuid
      `;
        // Видача готівки з каси (опційно) — по одній cash-out операції на співробітника.
        if (cashRegisterId) {
          for (const l of lines) {
            const amount = Number(l.accruedAmount);
            if (amount <= 0) continue;
            await this.cash.createOperation(
              orgId,
              {
                cashRegisterId,
                direction: 'OUT',
                amount,
                reason: 'PAYROLL',
                employeeId: l.employeeId,
                documentType: 'PayrollPeriod',
                documentId: id,
                createdBy: userId ?? null,
              },
              tx,
            );
          }
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    if (userId) {
      this.audit
        .record(orgId, 'PayrollPeriod', id, 'UPDATE', userId, undefined, { paid: true })
        .catch(() => undefined);
    }
    return this.findOne(orgId, id);
  }

  /** Soft-delete періоду (лише DRAFT/CANCELLED — розрахований/виплачений не видаляємо). */
  async remove(orgId: string, id: string, userId?: string): Promise<void> {
    const period = await this.prisma.payrollPeriod.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true },
    });
    if (!period)
      throw new NotFoundException(translateError('err.payroll.periodNotFound', getLocale()));
    // Виплачений період — фінансовий факт, не видаляємо. DRAFT/COMPUTED/CANCELLED можна відкинути
    // (COMPUTED — це ще не проведена виплата, користувач може перерахувати після виправлення даних).
    if (period.status === 'PAID')
      throw new BadRequestException(translateError('err.payroll.paidNotDeletable', getLocale()));
    await this.prisma.payrollPeriod.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (userId) {
      this.audit
        .record(orgId, 'PayrollPeriod', id, 'DELETE', userId, undefined, undefined)
        .catch(() => undefined);
    }
  }

  private toDto(period: {
    id: string;
    orgId: string;
    branchId: string | null;
    periodStart: Date;
    periodEnd: Date;
    status: string;
    note: string | null;
    computedAt: Date | null;
    paidAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    lines?: {
      employeeId: string;
      rateSchemeType: string;
      baseAmount: Prisma.Decimal;
      normoHours: number;
      linesCount: number;
      accruedAmount: Prisma.Decimal;
      paidAmount: Prisma.Decimal;
      employee?: { firstName: string; lastName: string };
      workOrders?: {
        workOrderId: string;
        workOrderNumber: string;
        vehicleName: string | null;
        worksCount: number;
        normoHours: number;
        baseAmount: Prisma.Decimal;
      }[];
    }[];
  }): PayrollPeriodResponseDto {
    const lines: PayrollLineDto[] | undefined = period.lines?.map(l => {
      const workOrders: PayrollLineWorkOrderDto[] | undefined = l.workOrders?.map(w => ({
        workOrderId: w.workOrderId,
        workOrderNumber: w.workOrderNumber,
        vehicleName: w.vehicleName,
        worksCount: w.worksCount,
        normoHours: w.normoHours,
        baseAmount: Number(w.baseAmount),
      }));
      return {
        employeeId: l.employeeId,
        employeeName: l.employee ? formatPersonName(l.employee.lastName, l.employee.firstName) : '',
        rateSchemeType: l.rateSchemeType,
        baseAmount: Number(l.baseAmount),
        normoHours: l.normoHours,
        linesCount: l.linesCount,
        accruedAmount: Number(l.accruedAmount),
        paidAmount: Number(l.paidAmount),
        ...(workOrders ? { workOrders } : {}),
      };
    });
    const totalAccrued = sumMoney((period.lines ?? []).map(l => moneyFromDecimal(l.accruedAmount)));
    const totalPaid = sumMoney((period.lines ?? []).map(l => moneyFromDecimal(l.paidAmount)));
    const iso = (d: Date | null) => (d instanceof Date ? d.toISOString() : (d ?? null));
    return {
      id: period.id,
      orgId: period.orgId,
      branchId: period.branchId,
      periodStart: period.periodStart.toISOString().slice(0, 10),
      periodEnd: period.periodEnd.toISOString().slice(0, 10),
      status: period.status,
      note: period.note,
      totalAccrued,
      totalPaid,
      lines,
      computedAt: iso(period.computedAt),
      paidAt: iso(period.paidAt),
      createdAt: period.createdAt.toISOString(),
      updatedAt: period.updatedAt.toISOString(),
    };
  }
}
