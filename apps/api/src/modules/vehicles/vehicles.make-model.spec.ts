import { BadRequestException } from '@nestjs/common';
import { describe, it, expect, beforeEach } from 'vitest';
import { vehicleCreateSchema, vehicleUpdateSchema } from '@sto/shared';
import { VehiclesService } from './vehicles.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CacheService } from '../../redis/cache.service';
import {
  ORG,
  OTHER_ORG,
  vehicleDirectoryWorld,
  type VehicleDirectoryWorld,
} from '../vehicle-makes/vehicle-makes.spec-fixture';

/**
 * Марка й модель авто з довідника (BR-VEH-008): `VehiclesService` над довідником і авто в пам'яті
 * (`where` виконується — «жива», «своя організація», «модель цієї марки» перевіряються на рядках).
 */
const GARAGE = '0c000000-0000-4000-8000-0000000000c3';

describe('VehiclesService — марка й модель з довідника (BR-VEH-008)', () => {
  let w: VehicleDirectoryWorld;
  let service: VehiclesService;
  beforeEach(() => {
    w = vehicleDirectoryWorld();
    service = new VehiclesService(
      w.prisma as unknown as PrismaService,
      w.cache as unknown as CacheService,
    );
  });

  const create = (makeId: unknown, modelId: unknown, extra: Record<string, unknown> = {}) =>
    service.create(
      ORG,
      vehicleCreateSchema.parse({ customerGarageId: GARAGE, makeId, modelId, ...extra }),
    );

  // guards: BR-VEH-008
  it('назви марки й моделі авто пише сервіс із довідника; рядок клієнта відкидає схема', async () => {
    const make = w.addMake('Toyota', { id: '0d000000-0000-4000-8000-000000000001' });
    const model = w.addModel(make.id as string, 'Camry', {
      id: '0d000000-0000-4000-8000-000000000002',
    });

    const created = await create(make.id, model.id, { make: 'Хак', model: 'Підміна' });

    expect(created).toMatchObject({
      makeId: make.id,
      modelId: model.id,
      make: 'Toyota',
      model: 'Camry',
    });
    expect(w.locks[0]).toMatch(/pg_advisory_xact_lock_shared\(/);
    expect(w.cache.del).toHaveBeenCalledWith(`ref:vehicle-makes:${ORG}`);
  });

  // guards: BR-VEH-008
  it('модель іншої марки → 400, авто не створюється', async () => {
    const toyota = w.addMake('Toyota', { id: '0d000000-0000-4000-8000-000000000011' });
    const bmw = w.addMake('BMW', { id: '0d000000-0000-4000-8000-000000000012' });
    const x5 = w.addModel(bmw.id as string, 'X5', { id: '0d000000-0000-4000-8000-000000000013' });

    const err = await create(toyota.id, x5.id).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe('Модель не належить обраній марці');
    expect(w.vehicles.rows).toHaveLength(0);
  });

  // guards: BR-VEH-008
  it.each([
    ['видалена марка', { deletedAt: new Date('2026-01-01') }, {}, 'Марку авто не знайдено'],
    ['марка чужої організації', { orgId: OTHER_ORG }, {}, 'Марку авто не знайдено'],
    ['видалена модель', {}, { deletedAt: new Date('2026-01-01') }, 'Модель авто не знайдено'],
    ['модель чужої організації', {}, { orgId: OTHER_ORG }, 'Модель авто не знайдено'],
  ])('%s → 400', async (_label, makeOver, modelOver, message) => {
    const make = w.addMake('Opel', { id: '0d000000-0000-4000-8000-000000000021', ...makeOver });
    const model = w.addModel(make.id as string, 'Astra', {
      id: '0d000000-0000-4000-8000-000000000022',
      ...modelOver,
    });

    await expect(create(make.id, model.id)).rejects.toThrow(message);
    expect(w.vehicles.rows).toHaveLength(0);
  });

  describe('зміна авто', () => {
    const ids = {
      toyota: '0d000000-0000-4000-8000-000000000031',
      camry: '0d000000-0000-4000-8000-000000000032',
      corolla: '0d000000-0000-4000-8000-000000000033',
      bmw: '0d000000-0000-4000-8000-000000000034',
      x5: '0d000000-0000-4000-8000-000000000035',
    };
    let vehicleId: string;
    beforeEach(() => {
      const toyota = w.addMake('Toyota', { id: ids.toyota });
      const camry = w.addModel(ids.toyota, 'Camry', { id: ids.camry });
      w.addModel(ids.toyota, 'Corolla', { id: ids.corolla });
      w.addMake('BMW', { id: ids.bmw });
      w.addModel(ids.bmw, 'X5', { id: ids.x5 });
      vehicleId = w.addVehicle(toyota, camry).id as string;
    });

    // guards: BR-VEH-008
    it('нова марка без моделі → 400 і в схемі, і в сервісі', async () => {
      expect(vehicleUpdateSchema.safeParse({ makeId: ids.bmw }).success).toBe(false);
      await expect(service.update(ORG, vehicleId, { makeId: ids.bmw })).rejects.toThrow(
        'Зі зміною марки оберіть і модель',
      );
    });

    // guards: BR-VEH-008
    it('нова модель без марки перевіряється проти ПОТОЧНОЇ марки авто', async () => {
      await expect(service.update(ORG, vehicleId, { modelId: ids.x5 })).rejects.toThrow(
        'Модель не належить обраній марці',
      );
      const updated = await service.update(ORG, vehicleId, { modelId: ids.corolla });
      expect(updated).toMatchObject({ makeId: ids.toyota, modelId: ids.corolla, model: 'Corolla' });
    });

    // guards: BR-VEH-008
    it('нова пара марка + модель → назви з довідника', async () => {
      const updated = await service.update(ORG, vehicleId, { makeId: ids.bmw, modelId: ids.x5 });
      expect(updated).toMatchObject({ makeId: ids.bmw, modelId: ids.x5, make: 'BMW', model: 'X5' });
    });

    it('зміна без марки й моделі не чіпає довідник і назви', async () => {
      const updated = await service.update(ORG, vehicleId, { color: 'Чорний' });
      expect(updated).toMatchObject({ make: 'Toyota', model: 'Camry', color: 'Чорний' });
      expect(w.locks).toHaveLength(0);
    });
  });
});
