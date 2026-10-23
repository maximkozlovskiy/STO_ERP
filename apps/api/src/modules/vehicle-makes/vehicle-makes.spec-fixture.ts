import { vi } from 'vitest';
import { vehicleNameKey } from '@sto/shared';
import {
  memoryTable,
  whereMatches,
  type MemRow,
  type MemoryTable,
} from '../cash/cash.spec-fixture';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CacheService } from '../../redis/cache.service';
import { VehicleMakesService } from './vehicle-makes.service';
import { VehicleModelsService } from './vehicle-models.service';

/**
 * Довідник марок і моделей + авто в пам'яті (BR-VEH-006…011). Фейкова Prisma ВИКОНУЄ `where`
 * (`memoryTable`): «лише живі авто», «разом із видаленими», «своя організація» перевіряються на
 * рядках, а не на заготовлених відповідях. `_count` рахує за умовою, яку передав сервіс.
 * `locks` — SQL блокувань довідника в порядку виклику.
 */
export const ORG = '0a000000-0000-4000-8000-0000000000a1';
export const OTHER_ORG = '0b000000-0000-4000-8000-0000000000b2';

export interface VehicleDirectoryWorld {
  prisma: Record<string, unknown>;
  makes: MemoryTable;
  models: MemoryTable;
  vehicles: MemoryTable;
  locks: string[];
  cache: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  addMake(name: string, over?: MemRow): MemRow;
  addModel(makeId: string, name: string, over?: MemRow): MemRow;
  addVehicle(make: MemRow, model: MemRow, over?: MemRow): MemRow;
}

let seq = 0;
const nextId = (prefix: string): string => {
  seq += 1;
  return `${prefix}-${String(seq).padStart(4, '0')}`;
};

export function vehicleDirectoryWorld(): VehicleDirectoryWorld {
  const tables: { makes?: MemoryTable; models?: MemoryTable; vehicles?: MemoryTable } = {};
  const rowsOf = (t: MemoryTable | undefined): MemRow[] => t?.rows ?? [];

  const countFor =
    (owner: 'makeId' | 'modelId') =>
    (row: MemRow, arg?: unknown): MemRow => {
      const select = (arg as { select?: Record<string, { where?: unknown } | true> } | undefined)
        ?.select;
      const out: MemRow = {};
      if (!select) return out;
      const whereOf = (v: { where?: unknown } | true): unknown =>
        v === true ? undefined : v.where;
      if (select.vehicles) {
        const where = whereOf(select.vehicles);
        out.vehicles = rowsOf(tables.vehicles).filter(
          v => v[owner] === row.id && whereMatches(v, where),
        ).length;
      }
      if (select.models) {
        const where = whereOf(select.models);
        out.models = rowsOf(tables.models).filter(
          m => m.makeId === row.id && whereMatches(m, where),
        ).length;
      }
      return out;
    };

  const stamp = () => ({ deletedAt: null, syncVersion: 1, createdAt: new Date() });
  const makes = memoryTable([], stamp, { _count: countFor('makeId') });
  const models = memoryTable([], stamp, {
    _count: countFor('modelId'),
    make: row => rowsOf(tables.makes).find(m => m.id === row.makeId) ?? null,
  });
  const vehicles = memoryTable([], stamp);
  Object.assign(tables, { makes, models, vehicles });

  const locks: string[] = [];
  const cache = {
    get: vi.fn(() => Promise.resolve(null)),
    set: vi.fn(() => Promise.resolve()),
    del: vi.fn(() => Promise.resolve()),
  };

  const prisma: Record<string, unknown> = {
    vehicleMake: makes,
    vehicleModel: models,
    vehicle: vehicles,
    $executeRaw: vi.fn((sql: TemplateStringsArray) => {
      locks.push(sql.join('?'));
      return Promise.resolve(1);
    }),
    // Гараж для `VehiclesService.create` (BR-CP-015) — тут завжди живий.
    $queryRaw: vi.fn(() => Promise.resolve([{ id: 'garage' }])),
  };
  prisma.$transaction = vi.fn((work: (tx: unknown) => Promise<unknown>) => work(prisma));

  return {
    prisma,
    makes,
    models,
    vehicles,
    locks,
    cache,
    addMake(name, over = {}) {
      const row: MemRow = {
        id: nextId('make'),
        orgId: ORG,
        name,
        nameKey: vehicleNameKey(name),
        ...stamp(),
        ...over,
      };
      makes.rows.push(row);
      return row;
    },
    addModel(makeId, name, over = {}) {
      const row: MemRow = {
        id: nextId('model'),
        orgId: ORG,
        makeId,
        name,
        nameKey: vehicleNameKey(name),
        ...stamp(),
        ...over,
      };
      models.rows.push(row);
      return row;
    },
    addVehicle(make, model, over = {}) {
      const row: MemRow = {
        id: nextId('veh'),
        orgId: ORG,
        customerGarageId: 'garage',
        makeId: make.id,
        modelId: model.id,
        make: make.name,
        model: model.name,
        ...stamp(),
        ...over,
      };
      vehicles.rows.push(row);
      return row;
    },
  };
}

export function makesService(world: VehicleDirectoryWorld): VehicleMakesService {
  return new VehicleMakesService(
    world.prisma as unknown as PrismaService,
    world.cache as unknown as CacheService,
  );
}

export function modelsService(world: VehicleDirectoryWorld): VehicleModelsService {
  return new VehicleModelsService(
    world.prisma as unknown as PrismaService,
    world.cache as unknown as CacheService,
  );
}
