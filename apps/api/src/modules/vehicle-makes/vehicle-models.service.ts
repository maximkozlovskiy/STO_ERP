import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { translateError, vehicleNameKey, type VehicleModelValues } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { getLocale } from '../../common/tenant/tenant-context';
import { CacheService } from '../../redis/cache.service';
import { VehicleModelListResponseDto, VehicleModelResponseDto } from './vehicle-makes.dto';
import { type Db, writeVehicleDirectory } from './vehicle-directory';

const LIST_CAP = 2000;

const MODEL_COUNTS = {
  _count: { select: { vehicles: { where: { deletedAt: null } } } },
} as const;

type ModelRow = {
  id: string;
  makeId: string;
  name: string;
  deletedAt: Date | null;
  _count?: { vehicles: number };
};

const modelNotFound = () =>
  new NotFoundException(translateError('err.vehicle.modelNotFound', getLocale()));
const makeNotFound = () =>
  new NotFoundException(translateError('err.vehicle.makeNotFound', getLocale()));
const makeDeleted = () =>
  new BadRequestException(translateError('err.vehicleModel.makeDeletedRestoreFirst', getLocale()));

/** Моделі марки (BR-VEH-007…011). Записи — під тим самим блокуванням, що й марки. */
@Injectable()
export class VehicleModelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(
    orgId: string,
    makeId: string,
    showDeleted = false,
  ): Promise<VehicleModelListResponseDto> {
    const make = await this.prisma.vehicleMake.findFirst({
      where: { id: makeId, orgId },
      select: { id: true },
    });
    if (!make) throw makeNotFound();
    const where = { orgId, makeId, ...(showDeleted ? {} : { deletedAt: null }) };
    const [rows, total] = await Promise.all([
      this.prisma.vehicleModel.findMany({
        where,
        include: MODEL_COUNTS,
        orderBy: [{ deletedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
        take: LIST_CAP,
      }),
      this.prisma.vehicleModel.count({ where }),
    ]);
    return { items: rows.map(toModelDto), total };
  }

  /** BR-VEH-007: модель лише живої марки; ключ назви унікальний у марці разом із видаленими. */
  async create(
    orgId: string,
    makeId: string,
    dto: VehicleModelValues,
  ): Promise<VehicleModelResponseDto> {
    const nameKey = vehicleNameKey(dto.name);
    const id = await writeVehicleDirectory(this.prisma, this.cache, orgId, async tx => {
      const make = await tx.vehicleMake.findFirst({
        where: { id: makeId, orgId },
        select: { deletedAt: true },
      });
      if (!make) throw makeNotFound();
      if (make.deletedAt) throw makeDeleted();
      await assertModelNameFree(tx, orgId, makeId, nameKey, null);
      const made = await tx.vehicleModel.create({
        data: { orgId, makeId, name: dto.name, nameKey },
        select: { id: true },
      });
      return made.id;
    });
    return this.read(orgId, id);
  }

  /** BR-VEH-007 + BR-VEH-011: нова назва — у знімок усіх авто моделі, разом із видаленими. */
  async rename(
    orgId: string,
    id: string,
    dto: VehicleModelValues,
  ): Promise<VehicleModelResponseDto> {
    const nameKey = vehicleNameKey(dto.name);
    await writeVehicleDirectory(this.prisma, this.cache, orgId, async tx => {
      const model = await tx.vehicleModel.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { makeId: true },
      });
      if (!model) throw modelNotFound();
      await assertModelNameFree(tx, orgId, model.makeId, nameKey, id);
      await tx.vehicleModel.update({ where: { id, orgId }, data: { name: dto.name, nameKey } });
      await tx.vehicle.updateMany({
        where: { orgId, modelId: id, model: { not: dto.name } },
        data: { model: dto.name },
      });
    });
    return this.read(orgId, id);
  }

  /** BR-VEH-009: модель із живими авто не видалити — 400 з пропозицією злити. */
  async remove(orgId: string, id: string): Promise<void> {
    await writeVehicleDirectory(this.prisma, this.cache, orgId, async tx => {
      const model = await tx.vehicleModel.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!model) throw modelNotFound();
      const inUse = await tx.vehicle.count({ where: { orgId, modelId: id, deletedAt: null } });
      if (inUse > 0)
        throw new BadRequestException(translateError('err.vehicleModel.inUse', getLocale()));
      await tx.vehicleModel.updateMany({
        where: { id, orgId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    });
  }

  /** BR-VEH-007: модель видаленої марки не відновлюється — спершу марку. */
  async restore(orgId: string, id: string): Promise<VehicleModelResponseDto> {
    await writeVehicleDirectory(this.prisma, this.cache, orgId, async tx => {
      const model = await tx.vehicleModel.findFirst({
        where: { id, orgId, NOT: { deletedAt: null } },
        select: { make: { select: { deletedAt: true } } },
      });
      if (!model)
        throw new NotFoundException(
          translateError('err.vehicleModel.deletedNotFound', getLocale()),
        );
      if (model.make.deletedAt) throw makeDeleted();
      await tx.vehicleModel.updateMany({
        where: { id, orgId, NOT: { deletedAt: null } },
        data: { deletedAt: null },
      });
    });
    return this.read(orgId, id);
  }

  /**
   * BR-VEH-010 + BR-VEH-011: злиття моделі `id` у `targetId` тієї ж марки. Авто переходять усі,
   * разом із видаленими, зі знімком назви цілі; модель-джерело видаляється.
   */
  async merge(orgId: string, id: string, targetId: string): Promise<VehicleModelResponseDto> {
    if (id === targetId)
      throw new BadRequestException(translateError('err.vehicleModel.mergeSelf', getLocale()));
    await writeVehicleDirectory(this.prisma, this.cache, orgId, async tx => {
      const [source, target] = await Promise.all([
        tx.vehicleModel.findFirst({
          where: { id, orgId, deletedAt: null },
          select: { makeId: true },
        }),
        tx.vehicleModel.findFirst({
          where: { id: targetId, orgId, deletedAt: null },
          select: { makeId: true, name: true },
        }),
      ]);
      if (!source || !target) throw modelNotFound();
      if (source.makeId !== target.makeId)
        throw new BadRequestException(
          translateError('err.vehicleModel.mergeOtherMake', getLocale()),
        );
      await tx.vehicle.updateMany({
        where: { orgId, modelId: id },
        data: { modelId: targetId, model: target.name },
      });
      await tx.vehicleModel.updateMany({
        where: { id, orgId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    });
    return this.read(orgId, targetId);
  }

  private async read(orgId: string, id: string): Promise<VehicleModelResponseDto> {
    const row = await this.prisma.vehicleModel.findFirst({
      where: { id, orgId },
      include: MODEL_COUNTS,
    });
    if (!row) throw modelNotFound();
    return toModelDto(row);
  }
}

/** BR-VEH-007: ключ зайнятий у цій марці — 409; серед видалених моделей — окреме повідомлення. */
async function assertModelNameFree(
  tx: Db,
  orgId: string,
  makeId: string,
  nameKey: string,
  exceptId: string | null,
): Promise<void> {
  const clash = await tx.vehicleModel.findFirst({
    where: { orgId, makeId, nameKey, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { deletedAt: true },
  });
  if (!clash) return;
  const key = clash.deletedAt
    ? 'err.vehicleModel.nameExistsDeleted'
    : 'err.vehicleModel.nameExists';
  throw new ConflictException(translateError(key, getLocale()));
}

function toModelDto(row: ModelRow): VehicleModelResponseDto {
  return {
    id: row.id,
    makeId: row.makeId,
    name: row.name,
    vehicleCount: row._count?.vehicles ?? 0,
    deletedAt: row.deletedAt instanceof Date ? row.deletedAt.toISOString() : null,
  };
}
