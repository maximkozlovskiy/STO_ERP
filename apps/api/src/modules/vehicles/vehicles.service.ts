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

  async findAll(
    orgId: string,
    customerGarageId?: string,
    counterpartyId?: string,
  ): Promise<VehicleResponseDto[]> {
    // sto-optimize: counterpartyId filter eliminates frontend N+1 (CRM/calendar
    // were doing garages → per-garage vehicles fetch). Single join replaces N RTT.
    const items = await this.prisma.vehicle.findMany({
      where: {
        orgId,
        deletedAt: null,
        ...(customerGarageId ? { customerGarageId } : {}),
        ...(counterpartyId ? { customerGarage: { counterpartyId, orgId, deletedAt: null } } : {}),
      },
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
    // sto-optimize: narrow FK guard — full CustomerGarage row read лише для existence.
    const garage = await this.prisma.customerGarage.findFirst({
      where: { id: dto.customerGarageId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!garage) throw new NotFoundException('Гараж не знайдено');
    const item = await this.prisma.vehicle.create({ data: { ...dto, orgId } });
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateVehicleDto): Promise<VehicleResponseDto> {
    // sto-optimize: narrow tenant guard — full Vehicle row (15+ columns) read лише для
    // 404 guard. Update нижче повертає актуальні дані. select:{id} зменшує wire payload.
    const existing = await this.prisma.vehicle.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Автомобіль не знайдено');
    const item = await this.prisma.vehicle.update({ where: { id, orgId }, data: dto });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // sto-optimize: `findOne + update` 2-RTT → atomic `updateMany` with compound
    // where (id+orgId+deletedAt:null). -1 RTT per delete.
    const result = await this.prisma.vehicle.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Автомобіль не знайдено');
  }

  // ─── VehicleNodes ────────────────────────────────────────

  async findNodes(orgId: string, vehicleId: string): Promise<VehicleNodeResponseDto[]> {
    // Parallel parent guard + child list (-1 RTT).
    const [vehicle, items] = await Promise.all([
      this.prisma.vehicle.findFirst({
        where: { id: vehicleId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.vehicleNode.findMany({
        where: { vehicleId, orgId, deletedAt: null },
        orderBy: { category: 'asc' },
        take: 200,
      }),
    ]);
    if (!vehicle) throw new NotFoundException('Автомобіль не знайдено');
    return items.map(item => this.toNodeDto(item));
  }

  async createNode(
    orgId: string,
    vehicleId: string,
    dto: CreateVehicleNodeDto,
  ): Promise<VehicleNodeResponseDto> {
    // sto-optimize: narrow tenant guard (id-only select) замість findOne що тягне
    // повний Vehicle об'єкт. findOne повертав DTO лише для існування — марно.
    const parent = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!parent) throw new NotFoundException('Автомобіль не знайдено');
    const item = await this.prisma.vehicleNode.create({ data: { ...dto, orgId, vehicleId } });
    return this.toNodeDto(item);
  }

  async removeNode(orgId: string, vehicleId: string, nodeId: string): Promise<void> {
    // Parallel parent (vehicle) guard + child (node) tenant-scoped fetch (-1 RTT).
    const [vehicle, node] = await Promise.all([
      this.prisma.vehicle.findFirst({
        where: { id: vehicleId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.vehicleNode.findFirst({
        where: { id: nodeId, vehicleId, orgId, deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (!vehicle) throw new NotFoundException('Автомобіль не знайдено');
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
      insuranceExpiry:
        item.insuranceExpiry instanceof Date
          ? item.insuranceExpiry.toISOString()
          : item.insuranceExpiry,
      inspectionExpiry:
        item.inspectionExpiry instanceof Date
          ? item.inspectionExpiry.toISOString()
          : item.inspectionExpiry,
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
      updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
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
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
    };
  }
}
