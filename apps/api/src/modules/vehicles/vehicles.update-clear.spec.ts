import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  VEHICLE_CLEARABLE_FIELDS,
  vehicleCreateSchema,
  vehicleUpdateSchema,
  type VehicleCreateValues,
  type VehicleUpdateValues,
} from '@sto/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { VehiclesService } from './vehicles.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';

/**
 * PATCH /vehicles/:id — очищення текстових полів картки авто.
 *
 * TECH-DEBT (а) 2026-11-01: картка авто слала `notes: null`, але `vehicleUpdateSchema`
 * (`optionalString`: '' і null → undefined) її з'їдала — PATCH 200, у БД старі нотатки.
 * Тіло проходить ту саму `ZodValidationPipe`, що й контролер, далі — `VehiclesService.update`.
 * 2026-11-04: так само рік, обʼєм, пробіг, дати страховки й техогляду (перелік спільний).
 */
describe('VehiclesService.update — очищення полів', () => {
  let service: VehiclesService;
  const vehicleUpdate = vi.fn();
  const vehicleCreate = vi.fn();

  const pipe = (body: Record<string, unknown>) =>
    new ZodValidationPipe<VehicleUpdateValues>(vehicleUpdateSchema).transform(body);

  beforeEach(async () => {
    vehicleUpdate.mockReset().mockResolvedValue({
      id: 'veh-1',
      orgId: 'org-1',
      customerGarageId: 'gar-1',
      makeId: 'mk-1',
      modelId: 'md-1',
      make: 'Toyota',
      model: 'Camry',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      deletedAt: null,
    });
    const prisma = {
      vehicle: {
        findFirst: vi.fn().mockResolvedValue({ id: 'veh-1', makeId: 'mk-1' }),
        update: vehicleUpdate,
        create: vehicleCreate,
      },
      // create: блокування довідника й гаража, назви марки й моделі — у транзакції.
      $transaction: (fn: (tx: unknown) => unknown) => fn(prisma),
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'gar-1' }]),
      vehicleMake: { findFirst: vi.fn().mockResolvedValue({ id: 'mk-1', name: 'Toyota' }) },
      vehicleModel: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ makeId: '0a000000-0000-4000-8000-00000000a001', name: 'Camry' }),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        VehiclesService,
        { provide: PrismaService, useValue: prisma },
        { provide: CacheService, useValue: { del: vi.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = module.get(VehiclesService);
  });

  const writtenData = (): Record<string, unknown> =>
    (vehicleUpdate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;

  it.each(VEHICLE_CLEARABLE_FIELDS.map(f => [f]))(
    "%s: '' з картки → null у prisma.vehicle.update",
    async field => {
      await service.update('org-1', 'veh-1', pipe({ [field]: '' }));
      expect(writtenData()).toHaveProperty(field, null);
    },
  );

  it('колір і нотатки очищено (null) — решта полів не потрапляє в data', async () => {
    await service.update('org-1', 'veh-1', pipe({ color: null, notes: null }));
    const data = writtenData();
    expect(data).toMatchObject({ color: null, notes: null });
    expect(data.vin).toBeUndefined();
    expect(data.licensePlate).toBeUndefined();
  });

  it('пробіг, рік, обʼєм очищено (null) — пробіг не стає 0', async () => {
    await service.update(
      'org-1',
      'veh-1',
      pipe({ currentMileage: '', year: null, engineVolume: '' }),
    );
    expect(writtenData()).toMatchObject({ currentMileage: null, year: null, engineVolume: null });
  });

  it('числа з картки — числами', async () => {
    await service.update('org-1', 'veh-1', pipe({ currentMileage: '120000', year: '2015' }));
    expect(writtenData()).toMatchObject({ currentMileage: 120000, year: 2015 });
  });

  // Дата з картки — `YYYY-MM-DD`; рядком Prisma її відкидала (400), і картка не зберігала жодної
  // дати страховки чи техогляду. Мутація: `data: dto` замість `withVehicleDates(dto)` → червоне.
  it('дата страховки YYYY-MM-DD → Date у prisma.vehicle.update; нечіпаний техогляд відсутній', async () => {
    await service.update('org-1', 'veh-1', pipe({ insuranceExpiry: '2027-03-15' }));
    const data = writtenData();
    expect(data.insuranceExpiry).toEqual(new Date('2027-03-15T00:00:00.000Z'));
    expect('inspectionExpiry' in data).toBe(false);
  });

  it('дата техогляду очищена → null', async () => {
    await service.update('org-1', 'veh-1', pipe({ inspectionExpiry: '' }));
    expect(writtenData()).toHaveProperty('inspectionExpiry', null);
  });

  it('створення: дата техогляду YYYY-MM-DD → Date у prisma.vehicle.create', async () => {
    vehicleCreate.mockResolvedValue({
      id: 'veh-2',
      orgId: 'org-1',
      customerGarageId: '0a000000-0000-4000-8000-00000000c001',
      makeId: 'mk-1',
      modelId: 'md-1',
      make: 'Toyota',
      model: 'Camry',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      deletedAt: null,
    });
    const dto = new ZodValidationPipe<VehicleCreateValues>(vehicleCreateSchema).transform({
      customerGarageId: '0a000000-0000-4000-8000-00000000c001',
      makeId: '0a000000-0000-4000-8000-00000000a001',
      modelId: '0a000000-0000-4000-8000-00000000b001',
      inspectionExpiry: '2027-05-01',
    });
    await service.create('org-1', dto);
    const data = (vehicleCreate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.inspectionExpiry).toEqual(new Date('2027-05-01T00:00:00.000Z'));
  });
});
