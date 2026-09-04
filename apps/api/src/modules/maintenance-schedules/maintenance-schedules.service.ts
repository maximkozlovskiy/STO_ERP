import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { addDaysKyiv } from '../../common/utils/kyiv-date';
import {
  CreateMaintenanceScheduleDto,
  UpdateMaintenanceScheduleDto,
  MaintenanceScheduleResponseDto,
} from './maintenance-schedules.dto';

@Injectable()
export class MaintenanceSchedulesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    orgId: string,
    vehicleId?: string,
    vehicleIds?: string[],
  ): Promise<MaintenanceScheduleResponseDto[]> {
    // vehicleIds (CSV → array) bulk filter — avoids frontend N+1 where
    // CRM counterparty page would otherwise dispatch one GET per vehicle
    // (e.g. 20 garages × 5 vehicles each = 100 HTTP round-trips).
    const safeIds = vehicleIds?.filter(Boolean).slice(0, 200);
    const vehicleFilter = vehicleId
      ? { vehicleId }
      : safeIds && safeIds.length > 0
        ? { vehicleId: { in: safeIds } }
        : {};

    const items = await this.prisma.maintenanceSchedule.findMany({
      where: {
        orgId,
        deletedAt: null,
        vehicle: { deletedAt: null },
        ...vehicleFilter,
      },
      include: { vehicle: { select: { make: true, model: true, licensePlate: true } } },
      orderBy: { nextMaintenanceDate: 'asc' },
      take: 500,
    });
    return items.map(item => this.toDto(item));
  }

  async findOne(orgId: string, id: string): Promise<MaintenanceScheduleResponseDto> {
    const item = await this.prisma.maintenanceSchedule.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { vehicle: { select: { make: true, model: true, licensePlate: true } } },
    });
    if (!item) throw new NotFoundException('Графік ТО не знайдено');
    return this.toDto(item);
  }

  async findUpcoming(orgId: string, days: number): Promise<MaintenanceScheduleResponseDto[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);
    const items = await this.prisma.maintenanceSchedule.findMany({
      where: {
        orgId,
        deletedAt: null,
        isActive: true,
        vehicle: { deletedAt: null },
        nextMaintenanceDate: { lte: cutoff },
      },
      include: { vehicle: { select: { make: true, model: true, licensePlate: true } } },
      orderBy: { nextMaintenanceDate: 'asc' },
      take: 200,
    });
    return items.map(item => this.toDto(item));
  }

  async create(
    orgId: string,
    dto: CreateMaintenanceScheduleDto,
  ): Promise<MaintenanceScheduleResponseDto> {
    // Narrow FK guard — потрібен лише факт існування.
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: dto.vehicleId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!vehicle) throw new NotFoundException('Авто не знайдено');

    const lastDate = dto.lastMaintenanceDate ? new Date(dto.lastMaintenanceDate) : null;
    const nextDate = this.calcNextDate(lastDate, dto.intervalDays);
    const nextMileage = this.calcNextMileage(dto.lastMaintenanceMileage, dto.intervalMileage);

    const item = await this.prisma.maintenanceSchedule.create({
      data: {
        orgId,
        vehicleId: dto.vehicleId,
        maintenanceType: dto.maintenanceType ?? 'REGULAR',
        intervalDays: dto.intervalDays ?? null,
        intervalMileage: dto.intervalMileage ?? null,
        lastMaintenanceDate: lastDate,
        lastMaintenanceMileage: dto.lastMaintenanceMileage ?? null,
        nextMaintenanceDate: nextDate,
        nextMaintenanceMileage: nextMileage ?? null,
        notes: dto.notes ?? null,
      },
      include: { vehicle: { select: { make: true, model: true, licensePlate: true } } },
    });
    return this.toDto(item);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateMaintenanceScheduleDto,
  ): Promise<MaintenanceScheduleResponseDto> {
    // Narrow select — read лише поля що потрібні для recalc/fallback. existing toDto
    // не використовується (фінальний DTO будується з результату update().vehicle).
    const existing = await this.prisma.maintenanceSchedule.findFirst({
      where: { id, orgId, deletedAt: null },
      select: {
        lastMaintenanceDate: true,
        lastMaintenanceMileage: true,
        intervalDays: true,
        intervalMileage: true,
        nextMaintenanceDate: true,
        nextMaintenanceMileage: true,
      },
    });
    if (!existing) throw new NotFoundException('Графік ТО не знайдено');

    // Recalculate next* only when an input that affects the calculation changes.
    const recalcAffectingFields = [
      'lastMaintenanceDate',
      'lastMaintenanceMileage',
      'intervalDays',
      'intervalMileage',
    ] as const;
    const shouldRecalc = recalcAffectingFields.some(f => dto[f] !== undefined);

    const lastDate =
      dto.lastMaintenanceDate !== undefined
        ? dto.lastMaintenanceDate
          ? new Date(dto.lastMaintenanceDate)
          : null
        : existing.lastMaintenanceDate;
    const intervalDays = dto.intervalDays !== undefined ? dto.intervalDays : existing.intervalDays;
    const intervalMileage =
      dto.intervalMileage !== undefined ? dto.intervalMileage : existing.intervalMileage;
    const lastMileage =
      dto.lastMaintenanceMileage !== undefined
        ? dto.lastMaintenanceMileage
        : existing.lastMaintenanceMileage;

    const nextDate = shouldRecalc
      ? this.calcNextDate(lastDate, intervalDays ?? undefined)
      : existing.nextMaintenanceDate;
    const nextMileage =
      dto.nextMaintenanceMileage !== undefined
        ? dto.nextMaintenanceMileage
        : shouldRecalc
          ? this.calcNextMileage(lastMileage ?? undefined, intervalMileage ?? undefined)
          : existing.nextMaintenanceMileage;

    const item = await this.prisma.maintenanceSchedule.update({
      where: { id, orgId },
      data: {
        maintenanceType: dto.maintenanceType,
        intervalDays: dto.intervalDays,
        intervalMileage: dto.intervalMileage,
        lastMaintenanceDate: lastDate,
        lastMaintenanceMileage: dto.lastMaintenanceMileage,
        nextMaintenanceDate: nextDate,
        nextMaintenanceMileage: nextMileage,
        isActive: dto.isActive,
        notes: dto.notes,
      },
      include: { vehicle: { select: { make: true, model: true, licensePlate: true } } },
    });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Defense-in-depth: atomic soft-delete via updateMany з orgId guard
    // (sto-optimize 1-RTT pattern 2026-05-31). 2 RTT → 1 RTT.
    const result = await this.prisma.maintenanceSchedule.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Графік ТО не знайдено');
  }

  async updateAfterWorkOrder(
    orgId: string,
    vehicleId: string,
    completedDate: Date,
    mileage?: number,
  ): Promise<void> {
    // Narrow projection — лише ці поля використовуються в recalc.
    const schedules = await this.prisma.maintenanceSchedule.findMany({
      where: { orgId, vehicleId, deletedAt: null, isActive: true },
      select: {
        id: true,
        intervalDays: true,
        intervalMileage: true,
        lastMaintenanceMileage: true,
      },
      take: 50,
    });
    // Each schedule update is independent (different `id`) and runs outside any
    // outer transaction → fan out in parallel to collapse N sequential RTT into one.
    await Promise.all(
      schedules.map(s => {
        const nextDate = this.calcNextDate(completedDate, s.intervalDays ?? undefined);
        const newMileage =
          mileage !== undefined ? mileage : (s.lastMaintenanceMileage ?? undefined);
        const nextMileage = this.calcNextMileage(newMileage, s.intervalMileage ?? undefined);
        return this.prisma.maintenanceSchedule.update({
          where: { id: s.id, orgId },
          data: {
            lastMaintenanceDate: completedDate,
            ...(mileage !== undefined ? { lastMaintenanceMileage: mileage } : {}),
            nextMaintenanceDate: nextDate,
            nextMaintenanceMileage: nextMileage ?? null,
          },
        });
      }),
    );
  }

  private calcNextDate(
    lastDate: Date | null | undefined,
    intervalDays: number | null | undefined,
  ): Date | null {
    if (!lastDate || !intervalDays) return null;
    // CAL-M3: +днів у Kyiv-календарі (DST-aware), не через server-local setDate — інакше на межі
    // доби/переходу DST дата наступного ТО зсувається на ±1 день. Уся система на Kyiv (kyiv-date).
    return addDaysKyiv(new Date(lastDate), intervalDays);
  }

  private calcNextMileage(
    lastMileage: number | null | undefined,
    interval: number | null | undefined,
  ): number | null {
    if (lastMileage == null || !interval) return null;
    return lastMileage + interval;
  }

  private toDto(item: {
    id: string;
    orgId: string;
    vehicleId: string;
    maintenanceType: string;
    intervalDays: number | null;
    intervalMileage: number | null;
    lastMaintenanceDate: Date | null;
    lastMaintenanceMileage: number | null;
    nextMaintenanceDate: Date | null;
    nextMaintenanceMileage: number | null;
    isActive: boolean;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
    vehicle: { make: string; model: string; licensePlate: string | null } | null;
  }): MaintenanceScheduleResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      vehicleId: item.vehicleId,
      vehicleLabel: item.vehicle
        ? `${item.vehicle.make} ${item.vehicle.model}${item.vehicle.licensePlate ? ` (${item.vehicle.licensePlate})` : ''}`
        : undefined,
      maintenanceType: item.maintenanceType,
      intervalDays: item.intervalDays,
      intervalMileage: item.intervalMileage,
      lastMaintenanceDate:
        item.lastMaintenanceDate instanceof Date
          ? item.lastMaintenanceDate.toISOString()
          : item.lastMaintenanceDate,
      lastMaintenanceMileage: item.lastMaintenanceMileage,
      nextMaintenanceDate:
        item.nextMaintenanceDate instanceof Date
          ? item.nextMaintenanceDate.toISOString()
          : item.nextMaintenanceDate,
      nextMaintenanceMileage: item.nextMaintenanceMileage,
      isActive: item.isActive,
      notes: item.notes,
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
      updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
    };
  }
}
