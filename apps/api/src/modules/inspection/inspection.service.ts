import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { translateError } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { getLocale } from '../../common/tenant/tenant-context';
import { CreateInspectionDto, InspectionResponseDto } from './inspection.dto';
import { EDITABLE_STATUSES } from '../work-orders/work-orders.fsm';
import { WorkOrderTotalsService } from '../work-orders/work-order-totals.service';
import { lineAmount } from '../../common/utils/money';

// Дефолтні точки огляду
export const DEFAULT_INSPECTION_POINTS = [
  { name: 'Гальмівні колодки', unit: 'мм', value: '', status: 'OK' as const },
  { name: 'Гальмівні диски', unit: 'мм', value: '', status: 'OK' as const },
  { name: 'Шини (перед)', unit: '%', value: '', status: 'OK' as const },
  { name: 'Шини (зад)', unit: '%', value: '', status: 'OK' as const },
  { name: 'Моторна олива', unit: 'л', value: '', status: 'OK' as const },
  { name: 'Гальмівна рідина', unit: '', value: '', status: 'OK' as const },
  { name: 'Охолоджувальна рідина', unit: '', value: '', status: 'OK' as const },
  { name: 'Акумулятор', unit: 'В', value: '', status: 'OK' as const },
];

@Injectable()
export class InspectionService {
  constructor(
    private prisma: PrismaService,
    private readonly totals: WorkOrderTotalsService,
  ) {}

  private toDto(
    r: {
      id: string;
      orgId: string;
      workOrderId: string;
      mileage: number | null;
      points: unknown;
      createdBy: string;
      createdAt: Date;
    },
    autoCreatedLines?: number,
  ): InspectionResponseDto {
    return {
      id: r.id,
      orgId: r.orgId,
      workOrderId: r.workOrderId,
      mileage: r.mileage ?? null,
      points: (Array.isArray(r.points) ? r.points : []) as InspectionResponseDto['points'],
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      autoCreatedLines,
    };
  }

  async create(
    orgId: string,
    workOrderId: string,
    dto: CreateInspectionDto,
    userId: string,
  ): Promise<InspectionResponseDto> {
    // Parallel: WO tenant guard + existing-report check (@@unique workOrderId). Both
    // read on the same logical aggregate but різні таблиці — independent (-1 RTT).
    const [wo, existing] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { status: true },
      }),
      this.prisma.inspectionReport.findFirst({
        where: { workOrderId, orgId },
        select: { id: true },
      }),
    ]);
    if (!wo) throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));
    if (existing)
      throw new ConflictException(translateError('err.inspection.reportExists', getLocale()));

    const criticalPoints = dto.points.filter(p => p.status === 'CRITICAL');
    const hasCritical = criticalPoints.length > 0;

    // If we will auto-create lines, the WO must still be editable.
    if (hasCritical && !EDITABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException(
        translateError('err.inspection.workLinesStatusForbidden', getLocale()),
      );
    }

    // Pre-fetch one match per critical point name in a single round-trip.
    // Using lowercased OR list avoids N findFirst calls in the loop.
    const works = hasCritical
      ? await this.prisma.work.findMany({
          where: {
            orgId,
            deletedAt: null,
            OR: criticalPoints.map(p => ({
              name: { contains: p.name, mode: 'insensitive' as const },
            })),
          },
          select: { id: true, price: true, normoHours: true, name: true },
          take: 200,
        })
      : [];

    // Match each critical point to its work by case-insensitive name containment.
    const pickWork = (pointName: string) =>
      works.find(w => w.name.toLowerCase().includes(pointName.toLowerCase())) ?? null;

    // All side effects in a single transaction to avoid partial state.
    // Explicit 10s timeout — loop creates N workOrderLine rows for critical points
    // (up to 50 points) which exceeds the 5s Prisma default.
    const { report, autoCreatedLines } = await this.prisma.$transaction(
      async tx => {
        const created = await tx.inspectionReport.create({
          data: {
            orgId,
            workOrderId,
            mileage: dto.mileage ?? null,
            points: dto.points as unknown as Prisma.InputJsonValue,
            createdBy: userId,
          },
        });

        // Build line data array up front — replaces N sequential tx.workOrderLine.create
        // with one tx.workOrderLine.createMany (1 INSERT vs N). criticalPoints can be
        // 50+ items (DEFAULT_INSPECTION_POINTS + custom) → noticeable speedup inside tx.
        const linesData: Prisma.WorkOrderLineCreateManyInput[] = [];
        for (const point of criticalPoints) {
          const work = pickWork(point.name);
          if (!work) continue;

          const price = Number(work.price);
          const normoHours = Number(work.normoHours);
          // Bug pattern §5.1: labour amount = normoHours * price, NOT just price.
          // BR-WO-007: рядок округлюється тим самим money(), що й у addLine і в тоталах. Сирий добуток
          // (0.3 × 100.05 = 30.014999…) Postgres клав у Decimal як 30.01, а тотали наряду брали
          // цей рядок як 30.02 — кошторис і сума наряду розходились на копійку (Bug #813).
          const amount = lineAmount(normoHours, price);

          linesData.push({
            orgId,
            workOrderId,
            workId: work.id,
            employeeId: userId,
            price: work.price,
            normoHours: work.normoHours,
            amount,
            notes: `Авто з огляду: ${point.name} — ${point.value}${point.unit ? ' ' + point.unit : ''}`,
          });
        }

        const createdLines = linesData.length;
        if (createdLines > 0) {
          await tx.workOrderLine.createMany({ data: linesData });
        }

        // Тотали наряду — лише через єдиного власника (BR-WO-007): ручний increment не знав ні
        // ПДВ, ні суми без ПДВ, ні base-суми у валюті.
        if (createdLines > 0) {
          await this.totals.recalc(workOrderId, tx, orgId);
        }

        return { report: created, autoCreatedLines: createdLines };
      },
      { timeout: 10_000 },
    );

    return this.toDto(report, autoCreatedLines);
  }

  async findByWorkOrder(orgId: string, workOrderId: string): Promise<InspectionResponseDto | null> {
    // Verify WO belongs to org AND fetch report concurrently — обидва читають за orgId,
    // тенант ізоляція дублюється в report query (orgId фільтр). Якщо WO не належить org —
    // повертаємо null незалежно від існування report. -1 RTT per call.
    const [wo, r] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.inspectionReport.findFirst({ where: { workOrderId, orgId } }),
    ]);
    if (!wo) return null;
    return r ? this.toDto(r) : null;
  }

  getDefaultPoints() {
    return DEFAULT_INSPECTION_POINTS;
  }
}
