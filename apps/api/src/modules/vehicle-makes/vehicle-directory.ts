import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CacheService } from '../../redis/cache.service';

export type Db = Prisma.TransactionClient;

/** Кеш списку марок (GET /vehicle-makes) — скидається і з записів авто: у ньому `vehicleCount`. */
export const vehicleMakesCacheKey = (orgId: string): string => `ref:vehicle-makes:${orgId}`;

const lockKey = (orgId: string): string => `vehicle-directory:${orgId}`;

/**
 * Записи довідника (створення, перейменування, видалення, злиття) ідуть під ексклюзивним
 * транзакційним блокуванням організації. Запис авто бере те саме блокування СПІЛЬНО
 * (`lockVehicleDirectoryShared`): перевірка «марку мають живі авто» (BR-VEH-009) і перенесення
 * авто при злитті (BR-VEH-010) не розминаються з одночасним збереженням авто на ту саму марку,
 * а знімок назви (BR-VEH-011) не читається до коміту перейменування. Авто між собою не чекають.
 */
export async function lockVehicleDirectory(tx: Db, orgId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(orgId)}))`;
}

export async function lockVehicleDirectoryShared(tx: Db, orgId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${lockKey(orgId)}))`;
}

/** Запис довідника: транзакція під блокуванням організації, після коміту — скидання кешу марок. */
export async function writeVehicleDirectory<T>(
  prisma: PrismaService,
  cache: CacheService,
  orgId: string,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  const result = await prisma.$transaction(async tx => {
    await lockVehicleDirectory(tx, orgId);
    return work(tx);
  });
  await cache.del(vehicleMakesCacheKey(orgId));
  return result;
}

/**
 * BR-VEH-008: марка й модель авто — живі рядки довідника своєї організації, модель належить марці.
 * Повертає назви для знімка `make` / `model`: клієнт їх не передає, їх пише сервіс.
 */
export async function resolveVehicleNames(
  db: Db,
  orgId: string,
  makeId: string,
  modelId: string,
): Promise<{ make: string; model: string }> {
  const [make, model] = await Promise.all([
    db.vehicleMake.findFirst({
      where: { id: makeId, orgId, deletedAt: null },
      select: { name: true },
    }),
    db.vehicleModel.findFirst({
      where: { id: modelId, orgId, deletedAt: null },
      select: { name: true, makeId: true },
    }),
  ]);
  if (!make) throw new BadRequestException(translateError('err.vehicle.makeNotFound', getLocale()));
  if (!model)
    throw new BadRequestException(translateError('err.vehicle.modelNotFound', getLocale()));
  if (model.makeId !== makeId)
    throw new BadRequestException(translateError('err.vehicle.modelNotOfMake', getLocale()));
  return { make: make.name, model: model.name };
}

/**
 * Пара для запису авто (BR-VEH-008). `existing === null` — нове авто: марка й модель обов'язкові.
 * Наявне авто: нова марка — лише разом із моделлю, нова модель без марки перевіряється проти
 * поточної марки (`existing.makeId`); `null` — запис марки й моделі не стосується.
 */
export function vehiclePairToWrite(
  input: { makeId?: unknown; modelId?: unknown },
  existing: { makeId: string | null } | null,
): { makeId: string; modelId: string } | null {
  const makeId = typeof input.makeId === 'string' && input.makeId ? input.makeId : null;
  const modelId = typeof input.modelId === 'string' && input.modelId ? input.modelId : null;
  if (existing && makeId === null && modelId === null) return null;
  if (modelId === null) {
    const key = makeId === null ? 'err.vehicle.makeNotFound' : 'err.vehicle.makeRequiresModel';
    throw new BadRequestException(translateError(key, getLocale()));
  }
  const pairMake = makeId ?? existing?.makeId ?? null;
  if (pairMake === null) {
    throw new BadRequestException(translateError('err.vehicle.makeNotFound', getLocale()));
  }
  return { makeId: pairMake, modelId };
}
