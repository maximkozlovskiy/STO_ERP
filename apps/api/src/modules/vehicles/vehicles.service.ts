import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateVehicleDto,
  CreateVehicleNodeDto,
  UpdateVehicleDto,
  VehicleNodeResponseDto,
  VehicleResponseDto,
} from './vehicles.dto';

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string, customerGarageId?: string): Promise<VehicleResponseDto[]> {
    const items = await this.prisma.vehicle.findMany({
      where: { orgId, deletedAt: null, ...(customerGarageId ? { customerGarageId } : {}) },
      orderBy: [{ make: 'asc' }, { model: 'asc' }],
      take: 200,
    });
    return items.map(item => this.toDto(item));
  }

  async findOne(orgId: string, id: string): Promise<VehicleResponseDto> {
    const item = await this.prisma.vehicle.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!item) throw new NotFoundException('Автомобіль не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateVehicleDto): Promise<VehicleResponseDto> {
    const garage = await this.prisma.customerGarage.findFirst({
      where: { id: dto.customerGarageId, orgId, deletedAt: null },
    });
    if (!garage) throw new NotFoundException('Гараж не знайдено');
    const item = await this.prisma.vehicle.create({ data: { ...dto, orgId } });
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateVehicleDto): Promise<VehicleResponseDto> {
    const existing = await this.prisma.vehicle.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Автомобіль не знайдено');
    const item = await this.prisma.vehicle.update({ where: { id, orgId }, data: dto });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const existing = await this.prisma.vehicle.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Автомобіль не знайдено');
    await this.prisma.vehicle.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
  }

  // ─── VehicleNodes ────────────────────────────────────────

  async findNodes(orgId: string, vehicleId: string): Promise<VehicleNodeResponseDto[]> {
    await this.findOne(orgId, vehicleId);
    const items = await this.prisma.vehicleNode.findMany({
      where: { vehicleId, orgId, deletedAt: null },
      orderBy: { category: 'asc' },
      take: 200,
    });
    return items.map(item => this.toNodeDto(item));
  }

  async createNode(
    orgId: string,
    vehicleId: string,
    dto: CreateVehicleNodeDto,
  ): Promise<VehicleNodeResponseDto> {
    await this.findOne(orgId, vehicleId);
    const item = await this.prisma.vehicleNode.create({ data: { ...dto, orgId, vehicleId } });
    return this.toNodeDto(item);
  }

  async removeNode(orgId: string, vehicleId: string, nodeId: string): Promise<void> {
    await this.findOne(orgId, vehicleId);
    const node = await this.prisma.vehicleNode.findFirst({
      where: { id: nodeId, vehicleId, orgId, deletedAt: null },
    });
    if (!node) throw new NotFoundException('Вузол не знайдено');
    await this.prisma.vehicleNode.update({
      where: { id: nodeId, orgId },
      data: { deletedAt: new Date() },
    });
  }

  private toDto(v: {
    id: string;
    orgId: string;
    customerGarageId: string;
    make: string;
    model: string;
    vin: string | null;
    licensePlate: string | null;
    year: number | null;
    engineVolume: number | null;
    fuelType: string | null;
    currentMileage: number | null;
    color: string | null;
    notes: string | null;
    transmissionType: string | null;
    driveType: string | null;
    bodyType: string | null;
    engineCode: string | null;
    insuranceExpiry: Date | null;
    inspectionExpiry: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): VehicleResponseDto {
    return {
      id: v.id,
      orgId: v.orgId,
      customerGarageId: v.customerGarageId,
      make: v.make,
      model: v.model,
      vin: v.vin,
      licensePlate: v.licensePlate,
      year: v.year,
      engineVolume: v.engineVolume,
      fuelType: v.fuelType,
      currentMileage: v.currentMileage,
      color: v.color,
      notes: v.notes,
      transmissionType: v.transmissionType,
      driveType: v.driveType,
      bodyType: v.bodyType,
      engineCode: v.engineCode,
      insuranceExpiry: v.insuranceExpiry,
      inspectionExpiry: v.inspectionExpiry,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    };
  }

  private toNodeDto(n: {
    id: string;
    vehicleId: string;
    category: string;
    name: string;
    mileageAtInstall: number | null;
    notes: string | null;
    createdAt: Date;
  }): VehicleNodeResponseDto {
    return {
      id: n.id,
      vehicleId: n.vehicleId,
      category: n.category,
      name: n.name,
      mileageAtInstall: n.mileageAtInstall,
      notes: n.notes,
      createdAt: n.createdAt,
    };
  }
}
