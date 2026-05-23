import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateLiftDto, CreateZoneDto, LiftResponseDto,
  UpdateLiftDto, UpdateZoneDto, ZoneResponseDto,
} from './zones.dto';

@Injectable()
export class ZonesService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Zones ───────────────────────────────────────────────

  async findAllZones(orgId: string, branchId?: string): Promise<ZoneResponseDto[]> {
    const items = await this.prisma.zone.findMany({
      where: { orgId, deletedAt: null, ...(branchId ? { branchId } : {}) },
      orderBy: { name: 'asc' },
    });
    return items.map(this.toZoneDto);
  }

  async findOneZone(orgId: string, id: string): Promise<ZoneResponseDto> {
    const item = await this.prisma.zone.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!item) throw new NotFoundException('Зону не знайдено');
    return this.toZoneDto(item);
  }

  async createZone(orgId: string, dto: CreateZoneDto): Promise<ZoneResponseDto> {
    const branch = await this.prisma.garageBranch.findFirst({
      where: { id: dto.branchId, orgId, deletedAt: null },
    });
    if (!branch) throw new NotFoundException('Філію не знайдено');
    const item = await this.prisma.zone.create({ data: { orgId, ...dto } });
    return this.toZoneDto(item);
  }

  async updateZone(orgId: string, id: string, dto: UpdateZoneDto): Promise<ZoneResponseDto> {
    await this.findOneZone(orgId, id);
    const item = await this.prisma.zone.update({ where: { id, orgId }, data: dto });
    return this.toZoneDto(item);
  }

  async removeZone(orgId: string, id: string): Promise<void> {
    await this.findOneZone(orgId, id);
    await this.prisma.zone.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
  }

  // ─── Lifts ───────────────────────────────────────────────

  async findAllLifts(orgId: string, zoneId?: string): Promise<LiftResponseDto[]> {
    const items = await this.prisma.lift.findMany({
      where: { orgId, deletedAt: null, ...(zoneId ? { zoneId } : {}) },
      orderBy: { name: 'asc' },
    });
    return items.map(this.toLiftDto);
  }

  async findOneLift(orgId: string, id: string): Promise<LiftResponseDto> {
    const item = await this.prisma.lift.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!item) throw new NotFoundException('Підйомник не знайдено');
    return this.toLiftDto(item);
  }

  async createLift(orgId: string, dto: CreateLiftDto): Promise<LiftResponseDto> {
    const zone = await this.prisma.zone.findFirst({
      where: { id: dto.zoneId, orgId, deletedAt: null },
    });
    if (!zone) throw new NotFoundException('Зону не знайдено');
    const item = await this.prisma.lift.create({ data: { orgId, ...dto } });
    return this.toLiftDto(item);
  }

  async updateLift(orgId: string, id: string, dto: UpdateLiftDto): Promise<LiftResponseDto> {
    await this.findOneLift(orgId, id);
    const item = await this.prisma.lift.update({ where: { id, orgId }, data: dto });
    return this.toLiftDto(item);
  }

  async removeLift(orgId: string, id: string): Promise<void> {
    await this.findOneLift(orgId, id);
    await this.prisma.lift.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
  }

  private toZoneDto(z: { id: string; orgId: string; branchId: string; name: string; type: string; createdAt: Date; updatedAt: Date }): ZoneResponseDto {
    return { id: z.id, orgId: z.orgId, branchId: z.branchId, name: z.name, type: z.type as any, createdAt: z.createdAt, updatedAt: z.updatedAt };
  }

  private toLiftDto(l: { id: string; orgId: string; zoneId: string; name: string; type: string; maxWeightKg: number | null; createdAt: Date; updatedAt: Date }): LiftResponseDto {
    return { id: l.id, orgId: l.orgId, zoneId: l.zoneId, name: l.name, type: l.type as any, maxWeightKg: l.maxWeightKg, createdAt: l.createdAt, updatedAt: l.updatedAt };
  }
}
