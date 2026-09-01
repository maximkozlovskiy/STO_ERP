import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
    showDeleted = false,
  ): Promise<VehicleResponseDto[]> {
    // sto-optimize: counterpartyId filter eliminates frontend N+1 (CRM/calendar
    // were doing garages → per-garage vehicles fetch). Single join replaces N RTT.
    // showDeleted: показує soft-deleted авто (форма контрагента, галка «Показувати видалені»).
    // Гараж-контейнер лишається `deletedAt: null` — видаляємо авто, не гараж.
    const items = await this.prisma.vehicle.findMany({
      where: {
        orgId,
        ...(showDeleted ? {} : { deletedAt: null }),
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

  async restore(orgId: string, id: string): Promise<VehicleResponseDto> {
    // Bug #601/#602: до atomic-restore перевіряємо чи chain-parents (garage → counterparty)
    // ще активні. `create()` захищає це для нових авто (findFirst гаража перед create),
    // але restore() без парного guard силентно створює orphan reference:
    //   - гараж soft-deleted (removeGarage не cascade-soft-deletes vehicles) → авто «зомбі»,
    //     не показується у `findAll(counterpartyId=)` (фільтр customerGarage.deletedAt:null)
    //   - CP soft-deleted (remove не cascade-soft-deletes garages) → авто у видаленому клієнті
    // Читаємо vehicle разом з garage.counterparty; distinguisher за станом ланцюга.
    const existing = await this.prisma.vehicle.findFirst({
      where: { id, orgId },
      select: {
        deletedAt: true,
        customerGarage: {
          select: {
            deletedAt: true,
            counterparty: { select: { deletedAt: true } },
          },
        },
      },
    });
    if (!existing) throw new NotFoundException('Видалене авто не знайдено');
    if (existing.deletedAt === null) {
      // double-restore — вже активне; лишаємо ту саму 404-семантику що для (id + orgId) misses.
      throw new NotFoundException('Видалене авто не знайдено');
    }
    if (existing.customerGarage.counterparty.deletedAt !== null) {
      throw new BadRequestException('Контрагента авто видалено. Спочатку відновіть контрагента.');
    }
    if (existing.customerGarage.deletedAt !== null) {
      throw new BadRequestException(
        'Гараж авто видалено. Спочатку відновіть гараж або перемістіть авто.',
      );
    }
    // Atomic updateMany з `NOT: { deletedAt: null }` — один statement стверджує
    // (id, orgId, currently-deleted), усуває race-вікно між findFirst + update
    // (еталон brands.service.restore).
    const result = await this.prisma.vehicle.updateMany({
      where: { id, orgId, NOT: { deletedAt: null } },
      data: { deletedAt: null },
    });
    if (result.count === 0) throw new NotFoundException('Видалене авто не знайдено');
    const item = await this.prisma.vehicle.findFirstOrThrow({ where: { id, orgId } });
    return this.toDto(item);
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
    deletedAt?: Date | null;
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
        v.insuranceExpiry instanceof Date ? v.insuranceExpiry.toISOString() : v.insuranceExpiry,
      inspectionExpiry:
        v.inspectionExpiry instanceof Date ? v.inspectionExpiry.toISOString() : v.inspectionExpiry,
      createdAt: v.createdAt instanceof Date ? v.createdAt.toISOString() : v.createdAt,
      updatedAt: v.updatedAt instanceof Date ? v.updatedAt.toISOString() : v.updatedAt,
      deletedAt: v.deletedAt instanceof Date ? v.deletedAt.toISOString() : (v.deletedAt ?? null),
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
      createdAt: n.createdAt instanceof Date ? n.createdAt.toISOString() : n.createdAt,
    };
  }
}
