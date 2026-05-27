import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateInspectionDto, InspectionResponseDto } from './inspection.dto';
import { EDITABLE_STATUSES } from '../work-orders/work-orders.fsm';

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
  constructor(private prisma: PrismaService) {}

  private toDto(r: {
    id: string;
    orgId: string;
    workOrderId: string;
    mileage: number | null;
    points: unknown;
    createdBy: string;
    createdAt: Date;
  }, autoCreatedLines?: number): InspectionResponseDto {
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
    // Перевірити що WO існує і належить org
    const wo = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, orgId, deletedAt: null },
    });
    if (!wo) throw new NotFoundException('Наряд не знайдено');

    // Перевірити що звіту ще немає (workOrderId is @@unique → ConflictException on duplicate)
    const existing = await this.prisma.inspectionReport.findUnique({
      where: { workOrderId },
    });
    if (existing) throw new ConflictException('Звіт огляду вже існує для цього наряду');

    // Find critical points and pre-fetch matching works in a single query (N+1 fix).
    const criticalPoints = dto.points.filter(p => p.status === 'CRITICAL');
    const hasCritical = criticalPoints.length > 0;

    // If we will auto-create lines, the WO must still be editable.
    if (hasCritical && !EDITABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException(
        'Не можна додавати рядки робіт у наряд цього статусу. Огляд з критичними точками потребує редагованого наряду.',
      );
    }

    // Pre-fetch one match per critical point name in a single round-trip.
    // Using lowercased OR list avoids N findFirst calls in the loop.
    const works = hasCritical
      ? await this.prisma.work.findMany({
          where: {
            orgId,
            deletedAt: null,
            OR: criticalPoints.map(p => ({ name: { contains: p.name, mode: 'insensitive' as const } })),
          },
          select: { id: true, price: true, normoHours: true, name: true },
          take: 200,
        })
      : [];

    // Match each critical point to its work by case-insensitive name containment.
    const pickWork = (pointName: string) =>
      works.find(w => w.name.toLowerCase().includes(pointName.toLowerCase()))
      ?? null;

    // All side effects in a single transaction to avoid partial state.
    const { report, autoCreatedLines } = await this.prisma.$transaction(async (tx) => {
      const created = await tx.inspectionReport.create({
        data: {
          orgId,
          workOrderId,
          mileage: dto.mileage ?? null,
          points: dto.points as unknown as Prisma.InputJsonValue,
          createdBy: userId,
        },
      });

      let createdLines = 0;
      let addedLabor = 0;

      for (const point of criticalPoints) {
        const work = pickWork(point.name);
        if (!work) continue;

        const price = Number(work.price);
        const normoHours = Number(work.normoHours);
        // Bug pattern §5.1: labour amount = normoHours * price, NOT just price.
        const amount = normoHours * price;

        await tx.workOrderLine.create({
          data: {
            orgId,
            workOrderId,
            workId: work.id,
            employeeId: userId,
            price: work.price,
            normoHours: work.normoHours,
            amount,
            notes: `Авто з огляду: ${point.name} — ${point.value}${point.unit ? ' ' + point.unit : ''}`,
          },
        });
        createdLines += 1;
        addedLabor += amount;
      }

      // Recalc WO totals so they match the freshly-inserted labour lines.
      if (createdLines > 0) {
        await tx.workOrder.update({
          where: { id: workOrderId, orgId },
          data: {
            totalLabor: { increment: addedLabor },
            totalAmount: { increment: addedLabor },
          },
        });
      }

      return { report: created, autoCreatedLines: createdLines };
    });

    return this.toDto(report, autoCreatedLines);
  }

  async findByWorkOrder(
    orgId: string,
    workOrderId: string,
  ): Promise<InspectionResponseDto | null> {
    // Verify WO belongs to org BEFORE returning the (potentially shared @@unique) report —
    // otherwise probing with a foreign UUID would reveal data from other tenants.
    const wo = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!wo) return null;

    const r = await this.prisma.inspectionReport.findFirst({
      where: { workOrderId, orgId },
    });
    return r ? this.toDto(r) : null;
  }

  getDefaultPoints() {
    return DEFAULT_INSPECTION_POINTS;
  }
}
