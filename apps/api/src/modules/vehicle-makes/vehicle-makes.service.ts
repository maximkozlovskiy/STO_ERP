import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { translateError, vehicleNameKey, type VehicleMakeValues } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { getLocale } from '../../common/tenant/tenant-context';
import { CacheService } from '../../redis/cache.service';
import { VehicleMakeListResponseDto, VehicleMakeResponseDto } from './vehicle-makes.dto';
import { type Db, vehicleMakesCacheKey, writeVehicleDirectory } from './vehicle-directory';

const TTL = 300;
const LIST_CAP = 2000;
/** Стеля моделей однієї марки при злитті — запобіжник безрозмірного запиту, не бізнес-ліміт. */
const MERGE_MODELS_CAP = 10_000;

// Лічильники — лише ЖИВІ авто й моделі: видалене авто марку не тримає (BR-VEH-009).
const MAKE_COUNTS = {
  _count: {
    select: {
      vehicles: { where: { deletedAt: null } },
      models: { where: { deletedAt: null } },
    },
  },
} as const;

type MakeRow = {
  id: string;
  name: string;
  deletedAt: Date | null;
  _count?: { vehicles: number; models: number };
};

const notFound = () =>
  new NotFoundException(translateError('err.vehicle.makeNotFound', getLocale()));

/**
 * Довідник марок авто (BR-VEH-006…013). Записи — під блокуванням організації
 * (`writeVehicleDirectory`), список живих марок — у кеші Redis (скидається й записами авто).
 */
@Injectable()
export class VehicleMakesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(orgId: string, showDeleted = false): Promise<VehicleMakeListResponseDto> {
    if (!showDeleted) {
      const cached = await this.cache.get<VehicleMakeListResponseDto>(vehicleMakesCacheKey(orgId));
      if (cached) return cached;
    }
    const where = { orgId, ...(showDeleted ? {} : { deletedAt: null }) };
    const [rows, total] = await Promise.all([
      this.prisma.vehicleMake.findMany({
        where,
        include: MAKE_COUNTS,
        orderBy: [{ deletedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
        take: LIST_CAP,
      }),
      this.prisma.vehicleMake.count({ where }),
    ]);
    const result = { items: rows.map(toMakeDto), total };
    if (!showDeleted) await this.cache.set(vehicleMakesCacheKey(orgId), result, TTL);
    return result;
  }

  /** BR-VEH-006: ключ назви унікальний в організації разом із видаленими марками. */
  async create(orgId: string, dto: VehicleMakeValues): Promise<VehicleMakeResponseDto> {
    const nameKey = vehicleNameKey(dto.name);
    const id = await writeVehicleDirectory(this.prisma, this.cache, orgId, async tx => {
      await assertMakeNameFree(tx, orgId, nameKey, null);
      const made = await tx.vehicleMake.create({
        data: { orgId, name: dto.name, nameKey },
        select: { id: true },
      });
      return made.id;
    });
    return this.read(orgId, id);
  }

  /** BR-VEH-006 + BR-VEH-011: нова назва пишеться й у знімок усіх авто марки, разом із видаленими. */
  async rename(orgId: string, id: string, dto: VehicleMakeValues): Promise<VehicleMakeResponseDto> {
    const nameKey = vehicleNameKey(dto.name);
    await writeVehicleDirectory(this.prisma, this.cache, orgId, async tx => {
      const make = await tx.vehicleMake.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!make) throw notFound();
      await assertMakeNameFree(tx, orgId, nameKey, id);
      await tx.vehicleMake.update({ where: { id, orgId }, data: { name: dto.name, nameKey } });
      await tx.vehicle.updateMany({
        where: { orgId, makeId: id, make: { not: dto.name } },
        data: { make: dto.name },
      });
    });
    return this.read(orgId, id);
  }

  /** BR-VEH-009: марку з живими авто не видалити; без них — видаляються й її живі моделі. */
  async remove(orgId: string, id: string): Promise<void> {
    await writeVehicleDirectory(this.prisma, this.cache, orgId, async tx => {
      const make = await tx.vehicleMake.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!make) throw notFound();
      const inUse = await tx.vehicle.count({ where: { orgId, makeId: id, deletedAt: null } });
      if (inUse > 0)
        throw new BadRequestException(translateError('err.vehicleMake.inUse', getLocale()));
      // Одна мітка часу на марку й її моделі: відновлення марки повертає саме їх.
      const now = new Date();
      await tx.vehicleMake.updateMany({
        where: { id, orgId, deletedAt: null },
        data: { deletedAt: now },
      });
      await tx.vehicleModel.updateMany({
        where: { orgId, makeId: id, deletedAt: null },
        data: { deletedAt: now },
      });
    });
  }

  /** Відновлює марку й моделі, видалені разом із нею (ті самі `deletedAt`). */
  async restore(orgId: string, id: string): Promise<VehicleMakeResponseDto> {
    await writeVehicleDirectory(this.prisma, this.cache, orgId, async tx => {
      const make = await tx.vehicleMake.findFirst({
        where: { id, orgId, NOT: { deletedAt: null } },
        select: { deletedAt: true },
      });
      const deletedAt = make?.deletedAt;
      if (!deletedAt)
        throw new NotFoundException(translateError('err.vehicleMake.deletedNotFound', getLocale()));
      await tx.vehicleMake.updateMany({
        where: { id, orgId, NOT: { deletedAt: null } },
        data: { deletedAt: null },
      });
      await tx.vehicleModel.updateMany({
        where: { orgId, makeId: id, deletedAt },
        data: { deletedAt: null },
      });
    });
    return this.read(orgId, id);
  }

  /**
   * BR-VEH-010 + BR-VEH-011: злиття марки `id` у `targetId`. Модель джерела, чий ключ уже є в цілі,
   * зливається з моделлю цілі (її авто переходять туди); решта моделей переходять до цілі. Авто
   * переносяться всі, разом із видаленими: інакше відновлене авто посилалось би на чужу пару.
   */
  async merge(orgId: string, id: string, targetId: string): Promise<VehicleMakeResponseDto> {
    if (id === targetId)
      throw new BadRequestException(translateError('err.vehicleMake.mergeSelf', getLocale()));
    await writeVehicleDirectory(this.prisma, this.cache, orgId, async tx => {
      const [source, target] = await Promise.all([
        tx.vehicleMake.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true } }),
        tx.vehicleMake.findFirst({
          where: { id: targetId, orgId, deletedAt: null },
          select: { name: true },
        }),
      ]);
      if (!source || !target) throw notFound();
      const [sourceModels, targetModels] = await Promise.all([
        tx.vehicleModel.findMany({
          where: { orgId, makeId: id },
          select: { id: true, nameKey: true, deletedAt: true },
          take: MERGE_MODELS_CAP,
        }),
        tx.vehicleModel.findMany({
          where: { orgId, makeId: targetId },
          select: { id: true, name: true, nameKey: true, deletedAt: true },
          take: MERGE_MODELS_CAP,
        }),
      ]);
      const now = new Date();
      const twins = new Map(targetModels.map(m => [m.nameKey, m]));
      const moved: string[] = [];
      for (const model of sourceModels) {
        const twin = twins.get(model.nameKey);
        if (!twin) {
          moved.push(model.id);
          continue;
        }
        // Жива модель джерела зливається з видаленою моделлю цілі → та оживає: авто не мають
        // посилатись на видалену модель.
        if (model.deletedAt === null && twin.deletedAt !== null) {
          await tx.vehicleModel.updateMany({
            where: { id: twin.id, orgId },
            data: { deletedAt: null },
          });
        }
        await tx.vehicle.updateMany({
          where: { orgId, modelId: model.id },
          data: { makeId: targetId, modelId: twin.id, make: target.name, model: twin.name },
        });
        if (model.deletedAt === null) {
          await tx.vehicleModel.updateMany({
            where: { id: model.id, orgId, deletedAt: null },
            data: { deletedAt: now },
          });
        }
      }
      if (moved.length > 0) {
        await tx.vehicleModel.updateMany({
          where: { orgId, id: { in: moved } },
          data: { makeId: targetId },
        });
      }
      await tx.vehicle.updateMany({
        where: { orgId, makeId: id },
        data: { makeId: targetId, make: target.name },
      });
      await tx.vehicleMake.updateMany({
        where: { id, orgId, deletedAt: null },
        data: { deletedAt: now },
      });
    });
    return this.read(orgId, targetId);
  }

  private async read(orgId: string, id: string): Promise<VehicleMakeResponseDto> {
    const row = await this.prisma.vehicleMake.findFirst({
      where: { id, orgId },
      include: MAKE_COUNTS,
    });
    if (!row) throw notFound();
    return toMakeDto(row);
  }
}

/** BR-VEH-006: зайнятий ключ — 409; видалена марка з тим самим ключем — окреме повідомлення. */
async function assertMakeNameFree(
  tx: Db,
  orgId: string,
  nameKey: string,
  exceptId: string | null,
): Promise<void> {
  const clash = await tx.vehicleMake.findFirst({
    where: { orgId, nameKey, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { deletedAt: true },
  });
  if (!clash) return;
  const key = clash.deletedAt ? 'err.vehicleMake.nameExistsDeleted' : 'err.vehicleMake.nameExists';
  throw new ConflictException(translateError(key, getLocale()));
}

function toMakeDto(row: MakeRow): VehicleMakeResponseDto {
  return {
    id: row.id,
    name: row.name,
    vehicleCount: row._count?.vehicles ?? 0,
    modelCount: row._count?.models ?? 0,
    deletedAt: row.deletedAt instanceof Date ? row.deletedAt.toISOString() : null,
  };
}
