import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  VEHICLE_CLEARABLE_FIELDS,
  vehicleUpdateSchema,
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
 */
describe('VehiclesService.update — очищення текстових полів', () => {
  let service: VehiclesService;
  const vehicleUpdate = vi.fn();

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
});
