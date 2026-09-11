import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS, formatPersonName } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CashService } from '../cash/cash.service';
import { roundMoney } from '../../common/utils/math';
import { computeAccrued, parseRateScheme } from './payroll.calculator';
import {
  CreatePayrollPeriodDto,
  PayrollLineDto,
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
    throw new BadRequestException('Дата початку має бути не пізніше дати закінчення');
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
      if (!branch) throw new NotFoundException('Філію не знайдено');
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
      const baseAmount = roundMoney(Number(r.totalAmount));
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

  /** Попередній розрахунок (без збереження). */
  async preview(
    orgId: string,
    from: string,
    to: string,
    branchId?: string,
  ): Promise<PayrollPreviewDto> {
    const { fromDate, toDate } = normalizeDateRange(from, to);
    const lines = await this.aggregate(orgId, fromDate, toDate, branchId);
    const totalAccrued = roundMoney(lines.reduce((s, l) => s + l.accruedAmount, 0));
    return { lines, totalAccrued, from, to };
  }

  async findAll(orgId: string): Promise<PayrollPeriodResponseDto[]> {
    const periods = await this.prisma.payrollPeriod.findMany({
      where: { orgId, deletedAt: null },
      include: {
        lines: { include: { employee: { select: { firstName: true, lastName: true } } } },
      },
      orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
    return periods.map(p => this.toDto(p));
  }

  async findOne(orgId: string, id: string): Promise<PayrollPeriodResponseDto> {
    const period = await this.prisma.payrollPeriod.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        lines: { include: { employee: { select: { firstName: true, lastName: true } } } },
      },
    });
    if (!period) throw new NotFoundException('Період не знайдено');
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
      if (!branch) throw new NotFoundException('Філію не знайдено');
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
    if (!period) throw new NotFoundException('Період не знайдено');
    if (period.status !== 'DRAFT')
      throw new BadRequestException('Розрахувати можна лише період у статусі «Чернетка»');

    const fromStr = period.periodStart.toISOString().slice(0, 10);
    const toStr = period.periodEnd.toISOString().slice(0, 10);
    const { fromDate, toDate } = normalizeDateRange(fromStr, toStr);
    const lines = await this.aggregate(orgId, fromDate, toDate, period.branchId ?? undefined);

    await this.prisma.$transaction(
      async tx => {
        // Атомарний claim: лише DRAFT → COMPUTED (переможець гонки — count===1).
        const claim = await tx.payrollPeriod.updateMany({
          where: { id, orgId, status: 'DRAFT' },
          data: { status: 'COMPUTED', computedAt: new Date(), computedBy: userId ?? null },
        });
        if (claim.count === 0)
          throw new BadRequestException('Період уже розраховано або змінено іншим користувачем');
        // Фіксуємо рядки (перестворюємо на випадок повторного DRAFT після скидання — тут DRAFT гарантований).
        await tx.payrollLine.deleteMany({ where: { orgId, periodId: id } });
        if (lines.length > 0) {
          await tx.payrollLine.createMany({
            data: lines.map(l => ({
              orgId,
              periodId: id,
              employeeId: l.employeeId,
              rateSchemeType: l.rateSchemeType,
              baseAmount: l.baseAmount,
              normoHours: l.normoHours,
              linesCount: l.linesCount,
              accruedAmount: l.accruedAmount,
            })),
          });
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
    if (!period) throw new NotFoundException('Період не знайдено');
    if (period.status !== 'COMPUTED')
      throw new BadRequestException('Виплатити можна лише розрахований період');

    // Рядки нарахувань (для cash-out по кожному співробітнику).
    const lines = await this.prisma.payrollLine.findMany({
      where: { orgId, periodId: id },
      select: { employeeId: true, accruedAmount: true },
    });

    await this.prisma.$transaction(
      async tx => {
        const claim = await tx.payrollPeriod.updateMany({
          where: { id, orgId, status: 'COMPUTED' },
          data: { status: 'PAID', paidAt: new Date(), paidBy: userId ?? null },
        });
        if (claim.count === 0)
          throw new BadRequestException('Період уже виплачено або змінено іншим користувачем');
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
    if (!period) throw new NotFoundException('Період не знайдено');
    // Виплачений період — фінансовий факт, не видаляємо. DRAFT/COMPUTED/CANCELLED можна відкинути
    // (COMPUTED — це ще не проведена виплата, користувач може перерахувати після виправлення даних).
    if (period.status === 'PAID')
      throw new BadRequestException('Не можна видалити виплачений період');
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
    }[];
  }): PayrollPeriodResponseDto {
    const lines: PayrollLineDto[] | undefined = period.lines?.map(l => ({
      employeeId: l.employeeId,
      employeeName: l.employee ? formatPersonName(l.employee.lastName, l.employee.firstName) : '',
      rateSchemeType: l.rateSchemeType,
      baseAmount: Number(l.baseAmount),
      normoHours: l.normoHours,
      linesCount: l.linesCount,
      accruedAmount: Number(l.accruedAmount),
      paidAmount: Number(l.paidAmount),
    }));
    const totalAccrued = roundMoney(
      (period.lines ?? []).reduce((s, l) => s + Number(l.accruedAmount), 0),
    );
    const totalPaid = roundMoney(
      (period.lines ?? []).reduce((s, l) => s + Number(l.paidAmount), 0),
    );
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
