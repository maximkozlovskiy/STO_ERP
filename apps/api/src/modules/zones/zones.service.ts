import { Injectable, NotFoundException } from '@nestjs/common';
import { LiftStatus, LiftType, ZoneType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import {
  CreateLiftDto,
  CreateZoneDto,
  LiftResponseDto,
  UpdateLiftDto,
  UpdateZoneDto,
  ZoneResponseDto,
} from './zones.dto';

const TTL = 300;
const zonesKey = (orgId: string, branchId?: string) =>
  `ref:zones:${orgId}${branchId ? `:${branchId}` : ''}`;
const liftsKey = (orgId: string, zoneId?: string) =>
  `ref:lifts:${orgId}${zoneId ? `:${zoneId}` : ''}`;

@Injectable()
export class ZonesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  // ─── Zones ───────────────────────────────────────────────

  async findAllZones(
    orgId: string,
    branchId?: string,
    showDeleted = false,
  ): Promise<ZoneResponseDto[]> {
    const key = zonesKey(orgId, branchId);
    if (!showDeleted) {
      const cached = await this.cache.get<ZoneResponseDto[]>(key);
      if (cached) return cached;
    }

    const items = await this.prisma.zone.findMany({
      where: {
        orgId,
        ...(!showDeleted ? { deletedAt: null } : {}),
        ...(branchId ? { branchId } : {}),
      },
      orderBy: { name: 'asc' },
      take: 500,
    });
    const result = items.map(item => this.toZoneDto(item));
    if (!showDeleted) await this.cache.set(key, result, TTL);
    return result;
  }

  async findOneZone(orgId: string, id: string): Promise<ZoneResponseDto> {
    const item = await this.prisma.zone.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!item) throw new NotFoundException('Зону не знайдено');
    return this.toZoneDto(item);
  }

  async createZone(orgId: string, dto: CreateZoneDto): Promise<ZoneResponseDto> {
    // sto-optimize: narrow FK guard — existence-only read для GarageBranch.
    const branch = await this.prisma.garageBranch.findFirst({
      where: { id: dto.branchId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Філію не знайдено');
    const item = await this.prisma.zone.create({ data: { ...dto, orgId } });
    await this.cache.delPattern(`ref:zones:${orgId}*`);
    return this.toZoneDto(item);
  }

  async updateZone(orgId: string, id: string, dto: UpdateZoneDto): Promise<ZoneResponseDto> {
    // Narrow tenant guard — findOneZone returns full DTO лише для існування,
    // що марно тут (update сам повертає DTO). select:{id} зменшує wire payload.
    const guard = await this.prisma.zone.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!guard) throw new NotFoundException('Зону не знайдено');
    const item = await this.prisma.zone.update({ where: { id, orgId }, data: dto });
    await this.cache.delPattern(`ref:zones:${orgId}*`);
    return this.toZoneDto(item);
  }

  async removeZone(orgId: string, id: string): Promise<void> {
    // sto-optimize: `findOne + update` 2-RTT → atomic `updateMany` with compound
    // where (id+orgId+deletedAt:null). -1 RTT per delete; race-safe.
    const result = await this.prisma.zone.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Зону не знайдено');
    await this.cache.delPattern(`ref:zones:${orgId}*`);
  }

  // ─── Lifts ───────────────────────────────────────────────

  async findAllLifts(
    orgId: string,
    zoneId?: string,
    showDeleted = false,
  ): Promise<LiftResponseDto[]> {
    const key = liftsKey(orgId, zoneId);
    if (!showDeleted) {
      const cached = await this.cache.get<LiftResponseDto[]>(key);
      if (cached) return cached;
    }

    const items = await this.prisma.lift.findMany({
      where: { orgId, ...(!showDeleted ? { deletedAt: null } : {}), ...(zoneId ? { zoneId } : {}) },
      orderBy: { name: 'asc' },
      take: 500,
    });
    const result = items.map(item => this.toLiftDto(item));
    if (!showDeleted) await this.cache.set(key, result, TTL);
    return result;
  }

  async findOneLift(orgId: string, id: string): Promise<LiftResponseDto> {
    const item = await this.prisma.lift.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!item) throw new NotFoundException('Підйомник не знайдено');
    return this.toLiftDto(item);
  }

  async createLift(orgId: string, dto: CreateLiftDto): Promise<LiftResponseDto> {
    // sto-optimize: narrow FK guard — existence-only read для Zone.
    const zone = await this.prisma.zone.findFirst({
      where: { id: dto.zoneId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!zone) throw new NotFoundException('Зону не знайдено');
    const item = await this.prisma.lift.create({ data: { ...dto, orgId } });
    await this.cache.delPattern(`ref:lifts:${orgId}*`);
    return this.toLiftDto(item);
  }

  async updateLift(orgId: string, id: string, dto: UpdateLiftDto): Promise<LiftResponseDto> {
    // Narrow tenant guard — findOneLift returns full DTO лише для існування,
    // що марно тут (update сам повертає DTO). select:{id} зменшує wire payload.
    const guard = await this.prisma.lift.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!guard) throw new NotFoundException('Підйомник не знайдено');
    const { purchaseDate, warrantyUntil, lastMaintenanceDate, ...rest } = dto;
    const item = await this.prisma.lift.update({
      where: { id, orgId },
      data: {
        ...rest,
        ...(purchaseDate !== undefined
          ? { purchaseDate: purchaseDate ? new Date(purchaseDate) : null }
          : {}),
        ...(warrantyUntil !== undefined
          ? { warrantyUntil: warrantyUntil ? new Date(warrantyUntil) : null }
          : {}),
        ...(lastMaintenanceDate !== undefined
          ? { lastMaintenanceDate: lastMaintenanceDate ? new Date(lastMaintenanceDate) : null }
          : {}),
      },
    });
    await this.cache.delPattern(`ref:lifts:${orgId}*`);
    return this.toLiftDto(item);
  }

  async removeLift(orgId: string, id: string): Promise<void> {
    // sto-optimize: `findOne + update` 2-RTT → atomic `updateMany` with compound
    // where (id+orgId+deletedAt:null). -1 RTT per delete; race-safe.
    const result = await this.prisma.lift.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Підйомник не знайдено');
    await this.cache.delPattern(`ref:lifts:${orgId}*`);
  }

  private toZoneDto(z: {
    id: string;
    orgId: string;
    branchId: string;
    name: string;
    type: string;
    createdAt: Date;
    updatedAt: Date;
    deletedAt?: Date | null;
  }): ZoneResponseDto {
    return {
      id: z.id,
      orgId: z.orgId,
      branchId: z.branchId,
      name: z.name,
      type: z.type as ZoneType,
      createdAt: z.createdAt instanceof Date ? z.createdAt.toISOString() : z.createdAt,
      updatedAt: z.updatedAt instanceof Date ? z.updatedAt.toISOString() : z.updatedAt,
      deletedAt: z.deletedAt instanceof Date ? z.deletedAt.toISOString() : z.deletedAt,
    };
  }

  private toLiftDto(l: {
    id: string;
    orgId: string;
    zoneId: string;
    name: string;
    type: string;
    maxWeightKg: number | null;
    status: LiftStatus;
    serialNumber: string | null;
    purchaseDate: Date | null;
    warrantyUntil: Date | null;
    maintenanceIntervalDays: number | null;
    lastMaintenanceDate: Date | null;
    nextMaintenanceDate: Date | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt?: Date | null;
  }): LiftResponseDto {
    return {
      id: l.id,
      orgId: l.orgId,
      zoneId: l.zoneId,
      name: l.name,
      type: l.type as LiftType,
      maxWeightKg: l.maxWeightKg,
      status: l.status,
      serialNumber: l.serialNumber,
      purchaseDate: l.purchaseDate instanceof Date ? l.purchaseDate.toISOString() : l.purchaseDate,
      warrantyUntil:
        l.warrantyUntil instanceof Date ? l.warrantyUntil.toISOString() : l.warrantyUntil,
      maintenanceIntervalDays: l.maintenanceIntervalDays,
      lastMaintenanceDate:
        l.lastMaintenanceDate instanceof Date
          ? l.lastMaintenanceDate.toISOString()
          : l.lastMaintenanceDate,
      nextMaintenanceDate:
        l.nextMaintenanceDate instanceof Date
          ? l.nextMaintenanceDate.toISOString()
          : l.nextMaintenanceDate,
      createdAt: l.createdAt instanceof Date ? l.createdAt.toISOString() : l.createdAt,
      updatedAt: l.updatedAt instanceof Date ? l.updatedAt.toISOString() : l.updatedAt,
      deletedAt: l.deletedAt instanceof Date ? l.deletedAt.toISOString() : l.deletedAt,
    };
  }
}
