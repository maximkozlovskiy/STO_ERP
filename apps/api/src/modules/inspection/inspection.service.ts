import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateInspectionDto, InspectionResponseDto } from './inspection.dto';

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
      points: (r.points as any[]) ?? [],
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

    // Перевірити що звіту ще немає
    const existing = await this.prisma.inspectionReport.findUnique({
      where: { workOrderId },
    });
    if (existing) throw new ConflictException('Звіт огляду вже існує для цього наряду');

    const report = await this.prisma.inspectionReport.create({
      data: {
        orgId,
        workOrderId,
        mileage: dto.mileage ?? null,
        points: dto.points as any,
        createdBy: userId,
      },
    });

    // Авто-створити WO lines для CRITICAL точок
    const criticalPoints = dto.points.filter(p => p.status === 'CRITICAL');
    let autoCreatedLines = 0;

    if (criticalPoints.length > 0) {
      for (const point of criticalPoints) {
        const work = await this.prisma.work.findFirst({
          where: {
            orgId,
            deletedAt: null,
            name: { contains: point.name, mode: 'insensitive' },
          },
        });

        if (work) {
          await this.prisma.workOrderLine.create({
            data: {
              orgId,
              workOrderId,
              workId: work.id,
              employeeId: userId,
              price: work.price,
              normoHours: work.normoHours,
              amount: work.price,
              notes: `Авто з огляду: ${point.name} — ${point.value}${point.unit ? ' ' + point.unit : ''}`,
            },
          });
          autoCreatedLines++;
        }
      }
    }

    return this.toDto(report, autoCreatedLines);
  }

  async findByWorkOrder(
    orgId: string,
    workOrderId: string,
  ): Promise<InspectionResponseDto | null> {
    const r = await this.prisma.inspectionReport.findFirst({
      where: { workOrderId, orgId },
    });
    return r ? this.toDto(r) : null;
  }

  getDefaultPoints() {
    return DEFAULT_INSPECTION_POINTS;
  }
}
