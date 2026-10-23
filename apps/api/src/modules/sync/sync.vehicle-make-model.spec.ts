import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncService } from './sync.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { WorkOrdersService } from '../work-orders/work-orders.service';
import type { CacheService } from '../../redis/cache.service';
import { memoryTable, type MemRow } from '../cash/cash.spec-fixture';
import {
  ORG,
  OTHER_ORG,
  vehicleDirectoryWorld,
  type VehicleDirectoryWorld,
} from '../vehicle-makes/vehicle-makes.spec-fixture';

/**
 * `POST /sync/push` для авто: марка й модель — ідентифікатори довідника, назви пише сервер
 * (BR-VEH-008). Довідник, авто й гаражі — у пам'яті з виконанням `where`.
 */
const GARAGE = '0c000000-0000-4000-8000-0000000000c3';
const NEW_ID = '0e000000-0000-4000-8000-0000000000e1';

describe('SyncService.push vehicles — марка й модель з довідника (BR-VEH-008)', () => {
  let w: VehicleDirectoryWorld;
  let sync: SyncService;
  let syncJobs: MemRow[];
  let toyota: MemRow;
  let camry: MemRow;
  let x5: MemRow;

  beforeEach(() => {
    w = vehicleDirectoryWorld();
    syncJobs = [];
    const prisma = {
      ...w.prisma,
      customerGarage: memoryTable([{ id: GARAGE, orgId: ORG, deletedAt: null }]),
      syncJob: {
        create: vi.fn((args: { data: MemRow }) => {
          syncJobs.push(args.data);
          return Promise.resolve(args.data);
        }),
      },
    };
    prisma.$transaction = vi.fn((work: (tx: unknown) => Promise<unknown>) => work(prisma));
    sync = new SyncService(
      prisma as unknown as PrismaService,
      {} as WorkOrdersService,
      w.cache as unknown as CacheService,
    );
    toyota = w.addMake('Toyota');
    camry = w.addModel(toyota.id as string, 'Camry');
    const bmw = w.addMake('BMW');
    x5 = w.addModel(bmw.id as string, 'X5');
  });

  const push = (operation: 'INSERT' | 'UPDATE', id: string, payload: Record<string, unknown>) =>
    sync.push(ORG, [{ table: 'vehicles', id, operation, syncVersion: 5, payload }], 'MECHANIC');

  // guards: BR-VEH-008
  it('нове авто: назви з довідника, рядки клієнта make/model відкинуто', async () => {
    const res = await push('INSERT', NEW_ID, {
      customerGarageId: GARAGE,
      makeId: toyota.id,
      modelId: camry.id,
      make: 'Хак',
      model: 'Підміна',
    });
    expect(res).toEqual({ accepted: 1, conflicts: 0 });
    expect(w.vehicles.rows[0]).toMatchObject({
      makeId: toyota.id,
      modelId: camry.id,
      make: 'Toyota',
      model: 'Camry',
    });
    expect(w.locks[0]).toMatch(/pg_advisory_xact_lock_shared\(/);
  });

  // guards: BR-VEH-009
  it('запис пари з планшета скидає кеш списку марок (лічильник авто); перенесення в гараж — ні', async () => {
    await push('INSERT', NEW_ID, {
      customerGarageId: GARAGE,
      makeId: toyota.id,
      modelId: camry.id,
    });
    expect(w.cache.del).toHaveBeenCalledTimes(1);
    expect(w.cache.del).toHaveBeenCalledWith(`ref:vehicle-makes:${ORG}`);

    // Гараж без пари теж іде транзакцією (BR-CP-015), але лічильників марок не змінює.
    w.cache.del.mockClear();
    const car = w.addVehicle(toyota, camry, { syncVersion: 1 });
    expect(await push('UPDATE', car.id as string, { customerGarageId: GARAGE })).toMatchObject({
      accepted: 1,
    });
    expect(w.cache.del).not.toHaveBeenCalled();
  });

  // guards: BR-VEH-008
  it.each([
    ['модель іншої марки', () => ({ makeId: toyota.id, modelId: x5.id }), 'не належить'],
    ['без марки й моделі', () => ({}), 'Марку авто не знайдено'],
    ['марка без моделі', () => ({ makeId: toyota.id }), 'оберіть і модель'],
  ])('нове авто: %s → конфлікт із причиною, авто не створюється', async (_l, pair, reason) => {
    const res = await push('INSERT', NEW_ID, { customerGarageId: GARAGE, ...pair() });
    expect(res).toEqual({ accepted: 0, conflicts: 1 });
    expect(w.vehicles.rows).toHaveLength(0);
    expect(String(syncJobs[0]?.lastError)).toContain(reason);
  });

  // guards: BR-VEH-008
  it('нове авто з маркою чужої організації → конфлікт', async () => {
    const foreign = w.addMake('Opel', { orgId: OTHER_ORG });
    const astra = w.addModel(foreign.id as string, 'Astra', { orgId: OTHER_ORG });
    const res = await push('INSERT', NEW_ID, {
      customerGarageId: GARAGE,
      makeId: foreign.id,
      modelId: astra.id,
    });
    expect(res.conflicts).toBe(1);
    expect(w.vehicles.rows).toHaveLength(0);
  });

  // guards: BR-VEH-008
  it('зміна авто: нова модель без марки — проти поточної марки; чужа марці модель → конфлікт', async () => {
    const car = w.addVehicle(toyota, camry, { syncVersion: 1 });
    const corolla = w.addModel(toyota.id as string, 'Corolla');

    expect(await push('UPDATE', car.id as string, { modelId: x5.id })).toMatchObject({
      conflicts: 1,
    });
    expect(car.modelId).toBe(camry.id);

    expect(await push('UPDATE', car.id as string, { modelId: corolla.id })).toMatchObject({
      accepted: 1,
    });
    expect(car).toMatchObject({ makeId: toyota.id, modelId: corolla.id, model: 'Corolla' });
  });

  it('зміна авто без марки й моделі (колір) — назви не чіпаються, довідник не блокується', async () => {
    const car = w.addVehicle(toyota, camry, { syncVersion: 1 });
    expect(await push('UPDATE', car.id as string, { color: 'Синій' })).toMatchObject({
      accepted: 1,
    });
    expect(car).toMatchObject({ color: 'Синій', make: 'Toyota', model: 'Camry' });
    expect(w.locks).toHaveLength(0);
  });
});
