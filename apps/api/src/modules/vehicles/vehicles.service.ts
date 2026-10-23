import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { translateError, type VehicleMileagePoint } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { getLocale } from '../../common/tenant/tenant-context';
import { kyivYmd } from '../../common/utils/kyiv-date';
import { CacheService } from '../../redis/cache.service';
import {
  VEHICLE_WRITE_TX_TIMEOUT_MS,
  assertVehiclePairLive,
  lockVehicleDirectoryShared,
  resolveVehicleNames,
  vehicleMakesCacheKey,
  vehiclePairToWrite,
} from '../vehicle-makes/vehicle-directory';
import {
  CreateVehicleDto,
  CreateVehicleNodeDto,
  UpdateVehicleDto,
  VehicleNodeResponseDto,
  VehicleResponseDto,
} from './vehicles.dto';

/** BR-VEH-005: скільки останніх записів історії пробігу віддаємо. */
const MILEAGE_HISTORY_LIMIT = 200;
/**
 * Запобіжна стеля вибірки нарядів одного авто. Дата запису — `completedAt ?? documentDate`
 * (BR-VEH-002), тобто обчислюване поле: відсортувати й обрізати «останні 200» у БД одним
 * `orderBy` неможливо, тому сортуємо в пам'яті. Стеля лише не дає запиту бути безрозмірним.
 */
const MILEAGE_HISTORY_FETCH_CAP = 2000;

@Injectable()
export class VehiclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

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
    if (!item) throw new NotFoundException(translateError('err.vehicle.notFound', getLocale()));
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateVehicleDto): Promise<VehicleResponseDto> {
    // MD-H2: VIN — природний унікальний ключ авто (немає DB-констрейнта, лише @@index). Без
    // перевірки один авто заводиться двічі → дублі в історії/пошуку по номеру.
    await this.assertVinUnique(orgId, dto.vin, null);
    // BR-CP-015: гараж блокується (FOR SHARE) до вставки авто в тій самій транзакції. Одночасне
    // видалення гаража (FOR UPDATE у `CounterpartiesService.removeGarage`) або чекає й лічильником
    // бачить це авто (400), або встигає першим — і тоді тут гараж уже видалений (404). Без
    // блокування авто могло опинитись у щойно видаленому гаражі (TECH-DEBT §17.2).
    // BR-VEH-008: марка й модель — з довідника, назви пише сервіс. Спільне блокування довідника:
    // одночасне видалення чи злиття марки (ексклюзивне) або чекає й бачить це авто, або вже
    // відбулось — і тоді марка тут не жива (400).
    const item = await this.prisma.$transaction(
      async tx => {
        await lockVehicleDirectoryShared(tx, orgId);
        const garage = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM customer_garages
          WHERE id = ${dto.customerGarageId}::uuid AND "orgId" = ${orgId}::uuid AND "deletedAt" IS NULL
          FOR SHARE
        `;
        if (garage.length === 0)
          throw new NotFoundException(translateError('err.vehicle.garageNotFound', getLocale()));
        const names = await resolveVehicleNames(tx, orgId, dto.makeId, dto.modelId);
        return tx.vehicle.create({ data: { ...dto, ...names, orgId } });
      },
      { timeout: VEHICLE_WRITE_TX_TIMEOUT_MS },
    );
    await this.invalidateMakes(orgId);
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateVehicleDto): Promise<VehicleResponseDto> {
    const existing = await this.prisma.vehicle.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, makeId: true },
    });
    if (!existing) throw new NotFoundException(translateError('err.vehicle.notFound', getLocale()));
    // MD-M5: UpdateVehicleDto НЕ містить customerGarageId (перенос гаража недоступний через update)
    // → крос-тенант-перенос неможливий за побудовою, окремий guard не потрібен.
    // MD-H2: VIN unique (виключаючи сам авто).
    await this.assertVinUnique(orgId, dto.vin, id);
    // BR-VEH-008: нова марка — лише з моделлю; нова модель без марки — моделлю поточної марки.
    const pair = vehiclePairToWrite(dto, existing);
    if (!pair) {
      const item = await this.prisma.vehicle.update({ where: { id, orgId }, data: dto });
      return this.toDto(item);
    }
    const item = await this.prisma.$transaction(
      async tx => {
        await lockVehicleDirectoryShared(tx, orgId);
        const names = await resolveVehicleNames(tx, orgId, pair.makeId, pair.modelId);
        return tx.vehicle.update({ where: { id, orgId }, data: { ...dto, ...pair, ...names } });
      },
      { timeout: VEHICLE_WRITE_TX_TIMEOUT_MS },
    );
    await this.invalidateMakes(orgId);
    return this.toDto(item);
  }

  /** Лічильники авто у кеші довідника марок (BR-VEH-009) — після кожного запису авто. */
  private async invalidateMakes(orgId: string): Promise<void> {
    await this.cache.del(vehicleMakesCacheKey(orgId));
  }

  /** VIN унікальний у межах org серед активних авто (крім excludeId). Порожній VIN пропускається. */
  private async assertVinUnique(
    orgId: string,
    vin: string | null | undefined,
    excludeId: string | null,
  ): Promise<void> {
    if (!vin) return;
    const clash = await this.prisma.vehicle.findFirst({
      where: { orgId, vin, deletedAt: null, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
      select: { id: true },
    });
    if (clash)
      throw new BadRequestException(translateError('err.vehicle.vinExists', getLocale(), { vin }));
  }

  async remove(orgId: string, id: string): Promise<void> {
    // A2: soft-delete guard — не можна видаляти авто з активними нарядами (інакше наряди лишаються
    // «живими» на видалене авто = orphaned records; FK Postgres не бачать deletedAt). Дзеркалить
    // counterparties.remove active-children guard. Активні = не ARCHIVED/CANCELLED.
    const activeWo = await this.prisma.workOrder.count({
      where: {
        orgId,
        vehicleId: id,
        deletedAt: null,
        status: { notIn: ['ARCHIVED', 'CANCELLED'] },
      },
    });
    if (activeWo > 0) {
      throw new BadRequestException(
        translateError('err.vehicle.hasActiveWorkOrders', getLocale(), { count: activeWo }),
      );
    }

    // sto-optimize: `findOne + update` 2-RTT → atomic `updateMany` with compound
    // where (id+orgId+deletedAt:null). -1 RTT per delete.
    const result = await this.prisma.vehicle.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0)
      throw new NotFoundException(translateError('err.vehicle.notFound', getLocale()));
    await this.invalidateMakes(orgId);
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
        customerGarageId: true,
        customerGarage: {
          select: {
            deletedAt: true,
            counterparty: { select: { deletedAt: true } },
          },
        },
      },
    });
    if (!existing)
      throw new NotFoundException(translateError('err.vehicle.deletedNotFound', getLocale()));
    if (existing.deletedAt === null) {
      // double-restore — вже активне; лишаємо ту саму 404-семантику що для (id + orgId) misses.
      throw new NotFoundException(translateError('err.vehicle.deletedNotFound', getLocale()));
    }
    if (existing.customerGarage.counterparty.deletedAt !== null) {
      throw new BadRequestException(
        translateError('err.vehicle.counterpartyDeletedRestoreFirst', getLocale()),
      );
    }
    if (existing.customerGarage.deletedAt !== null) {
      throw new BadRequestException(
        translateError('err.vehicle.garageDeletedRestoreFirst', getLocale()),
      );
    }
    // Atomic updateMany з `NOT: { deletedAt: null }` — один statement стверджує
    // (id, orgId, currently-deleted), усуває race-вікно між findFirst + update
    // (еталон brands.service.restore).
    // BR-CP-015 (Bug #949): відновлення — теж шлях, яким авто з'являється в гаражі. Гараж блокується
    // (FOR SHARE, як у `create`) у транзакції з відновленням: одночасне `removeGarage` (FOR UPDATE)
    // або чекає й лічильником бачить відновлене авто (400), або встигає першим — тоді тут 400.
    // Без блокування перевірка вище читала живий гараж, а він видалявся до запису (25/25 наживо).
    // BR-VEH-014: відновлене авто стає живим — його марка й модель мусять бути живими (BR-VEH-008).
    // Спільне блокування довідника (до гаража, у тому ж порядку, що й `create`): видалення марки
    // перевіряє «живі авто» під ексклюзивним, і відновлення не прослизає між перевіркою і записом.
    const result = await this.prisma.$transaction(
      async tx => {
        await lockVehicleDirectoryShared(tx, orgId);
        const garage = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM customer_garages
          WHERE id = ${existing.customerGarageId}::uuid AND "orgId" = ${orgId}::uuid
            AND "deletedAt" IS NULL
          FOR SHARE
        `;
        if (garage.length === 0)
          throw new BadRequestException(
            translateError('err.vehicle.garageDeletedRestoreFirst', getLocale()),
          );
        await assertVehiclePairLive(tx, orgId, id);
        return tx.vehicle.updateMany({
          where: { id, orgId, NOT: { deletedAt: null } },
          data: { deletedAt: null },
        });
      },
      { timeout: VEHICLE_WRITE_TX_TIMEOUT_MS },
    );
    if (result.count === 0)
      throw new NotFoundException(translateError('err.vehicle.deletedNotFound', getLocale()));
    await this.invalidateMakes(orgId);
    const item = await this.prisma.vehicle.findFirstOrThrow({ where: { id, orgId } });
    return this.toDto(item);
  }

  // ─── Історія пробігу ─────────────────────────────────────

  async getMileageHistory(orgId: string, vehicleId: string): Promise<VehicleMileagePoint[]> {
    // BR-VEH-004: авто перевіряється окремим запитом (orgId + deletedAt: null) — чужа org
    // і видалене авто дають той самий 404, що й GET /vehicles/:id.
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!vehicle) throw new NotFoundException(translateError('err.vehicle.notFound', getLocale()));

    // BR-VEH-001: наряди цього авто у своїй org, не видалені, не CANCELLED, із пробігом.
    const workOrders = await this.prisma.workOrder.findMany({
      where: {
        orgId,
        vehicleId,
        deletedAt: null,
        status: { not: 'CANCELLED' },
        OR: [{ outMileage: { not: null } }, { inMileage: { not: null } }],
      },
      select: {
        id: true,
        number: true,
        inMileage: true,
        outMileage: true,
        completedAt: true,
        documentDate: true,
      },
      orderBy: [{ documentDate: 'desc' }, { number: 'desc' }],
      take: MILEAGE_HISTORY_FETCH_CAP,
    });

    const records: { id: string; number: string; at: Date; day: string; mileage: number }[] = [];
    for (const wo of workOrders) {
      // BR-VEH-001: outMileage, а якщо його немає — inMileage; без обох — не запис історії.
      const mileage = wo.outMileage ?? wo.inMileage;
      if (mileage === null || mileage === undefined) continue;
      // BR-VEH-002: completedAt, а якщо наряд не завершено — documentDate.
      // `day` — календарний день запису за Києвом, ключ сортування. documentDate — дата БЕЗ
      // часу (`@db.Date` → опівніч UTC київської дати), completedAt — момент. Порівнювати їх
      // як мітки часу не можна: наряд, відкритий того ж дня ПІСЛЯ вже завершеного, ставав
      // перед ним, і завершений наряд хибно отримував isRollback (Bug #798).
      records.push({
        id: wo.id,
        number: wo.number,
        at: wo.completedAt ?? wo.documentDate,
        day: wo.completedAt ? kyivYmd(wo.completedAt) : wo.documentDate.toISOString().slice(0, 10),
        mileage,
      });
    }

    // BR-VEH-002: від старішого дня до новішого; у межах одного дня — за номером наряду.
    records.sort(
      (a, b) =>
        (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) ||
        a.number.localeCompare(b.number, 'uk', { numeric: true }),
    );

    // BR-VEH-003: відкат рахується по ПОВНІЙ історії до обрізання — інакше перший запис
    // вікна втратив би позначку лише тому, що його попередник не потрапив у 200.
    const points = records.map((record, index): VehicleMileagePoint => {
      const previous = index > 0 ? records[index - 1] : undefined;
      return {
        workOrderId: record.id,
        workOrderNumber: record.number,
        date: record.at.toISOString(),
        mileage: record.mileage,
        isRollback: previous !== undefined && record.mileage < previous.mileage,
      };
    });

    // BR-VEH-005: не більше 200 ОСТАННІХ записів, порядок лишається старіший → новіший.
    return points.slice(-MILEAGE_HISTORY_LIMIT);
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
    if (!vehicle) throw new NotFoundException(translateError('err.vehicle.notFound', getLocale()));
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
    if (!parent) throw new NotFoundException(translateError('err.vehicle.notFound', getLocale()));
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
    if (!vehicle) throw new NotFoundException(translateError('err.vehicle.notFound', getLocale()));
    if (!node) throw new NotFoundException(translateError('err.vehicle.nodeNotFound', getLocale()));
    await this.prisma.vehicleNode.update({
      where: { id: nodeId, orgId },
      data: { deletedAt: new Date() },
    });
  }

  private toDto(v: {
    id: string;
    orgId: string;
    customerGarageId: string;
    makeId: string;
    modelId: string;
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
      makeId: v.makeId,
      modelId: v.modelId,
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
