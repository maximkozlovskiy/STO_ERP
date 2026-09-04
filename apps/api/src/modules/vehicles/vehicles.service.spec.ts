import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { VehiclesService } from './vehicles.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Bug #601/#602/#605 — regression-guards для нових endpoints:
 *   POST /vehicles/:id/restore (Bug #601: parent garage guard; Bug #602: parent CP guard)
 *   GET  /vehicles?showDeleted=true (Bug #605: shape/tenant guards)
 *
 * До цього комміту модуль vehicles взагалі не мав service-spec; тепер створено
 * baseline із покриттям restore + findAll(showDeleted) + remove() atomic invariants.
 */
describe('VehiclesService', () => {
  let service: VehiclesService;
  let prisma: {
    vehicle: {
      findMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findFirstOrThrow: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    customerGarage: {
      findFirst: ReturnType<typeof vi.fn>;
    };
    vehicleNode: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };

  const rawVehicle = (overrides: Record<string, unknown> = {}) => ({
    id: 'veh-1',
    orgId: 'org-1',
    customerGarageId: 'gar-1',
    make: 'Toyota',
    model: 'Camry',
    vin: null,
    licensePlate: null,
    year: null,
    engineVolume: null,
    fuelType: null,
    currentMileage: null,
    color: null,
    notes: null,
    transmissionType: null,
    driveType: null,
    bodyType: null,
    engineCode: null,
    insuranceExpiry: null,
    inspectionExpiry: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      vehicle: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn(),
        findFirstOrThrow: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      customerGarage: {
        findFirst: vi.fn(),
      },
      vehicleNode: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    };

    const module = await Test.createTestingModule({
      providers: [VehiclesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(VehiclesService);
  });

  describe('findAll — showDeleted param (Bug #605 regression)', () => {
    it('showDeleted=false (default) → додає deletedAt:null у where', async () => {
      await service.findAll('org-1');
      const where = prisma.vehicle.findMany.mock.calls[0][0].where;
      expect(where.orgId).toBe('org-1');
      expect(where.deletedAt).toBeNull();
    });

    it('showDeleted=true → НЕ додає deletedAt:null (повертає й soft-deleted)', async () => {
      await service.findAll('org-1', undefined, undefined, true);
      const where = prisma.vehicle.findMany.mock.calls[0][0].where;
      expect(where.orgId).toBe('org-1');
      expect(where).not.toHaveProperty('deletedAt');
    });

    it('showDeleted=true + counterpartyId → зберігає nested customerGarage-filter з deletedAt:null (гараж-контейнер лишається активним)', async () => {
      await service.findAll('org-1', undefined, 'cp-1', true);
      const where = prisma.vehicle.findMany.mock.calls[0][0].where;
      expect(where.customerGarage).toEqual({
        counterpartyId: 'cp-1',
        orgId: 'org-1',
        deletedAt: null,
      });
      // top-level deletedAt відсутній (показуємо видалені авто), але гараж має бути активний
      expect(where).not.toHaveProperty('deletedAt');
    });

    it('showDeleted=true ЗАВЖДИ зберігає tenant-фільтр orgId', async () => {
      await service.findAll('org-99', undefined, undefined, true);
      const where = prisma.vehicle.findMany.mock.calls[0][0].where;
      expect(where.orgId).toBe('org-99');
    });
  });

  describe('remove — atomic soft-delete (baseline invariants)', () => {
    it('updateMany з compound where (id + orgId + deletedAt:null)', async () => {
      prisma.vehicle.updateMany.mockResolvedValueOnce({ count: 1 });
      await service.remove('org-1', 'veh-1');
      expect(prisma.vehicle.updateMany).toHaveBeenCalledWith({
        where: { id: 'veh-1', orgId: 'org-1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('count===0 → NotFoundException (авто немає / чужа org / вже видалене)', async () => {
      prisma.vehicle.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.remove('org-1', 'veh-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('restore — Bug #601 (parent garage) + Bug #602 (parent CP) + Bug #605 baseline', () => {
    // ВАЖЛИВО: `??` повертає fallback і для `null`, і для `undefined` — тому явно
    // перевіряємо `in overrides` щоб дозволити пере-override `deletedAt: null` (double-restore case).
    const buildExisting = (
      overrides: Partial<{
        deletedAt: Date | null;
        garageDeleted: Date | null;
        cpDeleted: Date | null;
      }> = {},
    ) => ({
      deletedAt: 'deletedAt' in overrides ? overrides.deletedAt : new Date('2026-01-01T00:00:00Z'),
      customerGarage: {
        deletedAt: 'garageDeleted' in overrides ? overrides.garageDeleted : null,
        counterparty: {
          deletedAt: 'cpDeleted' in overrides ? overrides.cpDeleted : null,
        },
      },
    });

    it('happy-path: авто soft-deleted, гараж активний, CP активний → 200 + deletedAt=null у DTO', async () => {
      prisma.vehicle.findFirst.mockResolvedValueOnce(buildExisting());
      prisma.vehicle.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.vehicle.findFirstOrThrow.mockResolvedValueOnce(rawVehicle({ deletedAt: null }));
      const res = await service.restore('org-1', 'veh-1');
      expect(res.deletedAt).toBeNull();
      expect(res.id).toBe('veh-1');
      // updateMany отримав compound where (tenant + NOT:{deletedAt:null}) + data
      expect(prisma.vehicle.updateMany).toHaveBeenCalledWith({
        where: { id: 'veh-1', orgId: 'org-1', NOT: { deletedAt: null } },
        data: { deletedAt: null },
      });
    });

    it('Bug #601: гараж soft-deleted → BadRequestException, БЕЗ write-op', async () => {
      prisma.vehicle.findFirst.mockResolvedValueOnce(
        buildExisting({ garageDeleted: new Date('2026-01-02T00:00:00Z') }),
      );
      await expect(service.restore('org-1', 'veh-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
    });

    it('Bug #602: CP soft-deleted → BadRequestException, БЕЗ write-op', async () => {
      prisma.vehicle.findFirst.mockResolvedValueOnce(
        buildExisting({ cpDeleted: new Date('2026-01-02T00:00:00Z') }),
      );
      await expect(service.restore('org-1', 'veh-1')).rejects.toThrow(/Контрагента авто видалено/);
      expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
    });

    it('Bug #602 має пріоритет над Bug #601: якщо обидва — CP і гараж видалені — CP-повідомлення (людині зрозуміліше)', async () => {
      prisma.vehicle.findFirst.mockResolvedValueOnce(
        buildExisting({
          garageDeleted: new Date('2026-01-02T00:00:00Z'),
          cpDeleted: new Date('2026-01-02T00:00:00Z'),
        }),
      );
      await expect(service.restore('org-1', 'veh-1')).rejects.toThrow(/Контрагента авто видалено/);
      // НЕ гараж-повідомлення (той у цьому кейсі — вторинний ефект)
      expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
    });

    it('double-restore (авто вже активне) → NotFoundException, БЕЗ write-op', async () => {
      prisma.vehicle.findFirst.mockResolvedValueOnce(buildExisting({ deletedAt: null }));
      await expect(service.restore('org-1', 'veh-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
    });

    it('cross-tenant / non-existent → NotFoundException', async () => {
      prisma.vehicle.findFirst.mockResolvedValueOnce(null);
      await expect(service.restore('org-1', 'veh-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
    });

    it('пре-check findFirst містить orgId (tenant isolation) + full parent chain у select', async () => {
      prisma.vehicle.findFirst.mockResolvedValueOnce(buildExisting());
      prisma.vehicle.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.vehicle.findFirstOrThrow.mockResolvedValueOnce(rawVehicle({ deletedAt: null }));
      await service.restore('org-7', 'veh-1');
      const call = prisma.vehicle.findFirst.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'veh-1', orgId: 'org-7' });
      // select обов'язково має garage.counterparty.deletedAt для Bug #602 guard
      expect(call.select.customerGarage.select.counterparty.select.deletedAt).toBe(true);
      expect(call.select.customerGarage.select.deletedAt).toBe(true);
    });
  });

  // MD-H2: VIN унікальний у межах org.
  describe('create/update — VIN uniqueness (MD-H2)', () => {
    it('create з дубль-VIN → BadRequestException', async () => {
      prisma.customerGarage.findFirst.mockResolvedValueOnce({ id: 'g-1' });
      prisma.vehicle.findFirst.mockResolvedValueOnce({ id: 'other' }); // VIN clash
      await expect(
        service.create('org-1', { customerGarageId: 'g-1', vin: 'WVWZZZ' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.vehicle.create).not.toHaveBeenCalled();
    });

    it('create з унікальним VIN → створює', async () => {
      prisma.customerGarage.findFirst.mockResolvedValueOnce({ id: 'g-1' });
      prisma.vehicle.findFirst.mockResolvedValueOnce(null); // no clash
      prisma.vehicle.create.mockResolvedValueOnce({ id: 'v-1', customerGarageId: 'g-1' });
      await service.create('org-1', { customerGarageId: 'g-1', vin: 'UNIQUE1' } as never);
      expect(prisma.vehicle.create).toHaveBeenCalledTimes(1);
      // VIN-lookup виключає deletedAt (лише активні дублі).
      const vinCall = prisma.vehicle.findFirst.mock.calls[0][0];
      expect(vinCall.where).toMatchObject({ orgId: 'org-1', vin: 'UNIQUE1', deletedAt: null });
    });

    it('create без VIN → перевірка пропускається', async () => {
      prisma.customerGarage.findFirst.mockResolvedValueOnce({ id: 'g-1' });
      prisma.vehicle.create.mockResolvedValueOnce({ id: 'v-1', customerGarageId: 'g-1' });
      await service.create('org-1', { customerGarageId: 'g-1' } as never);
      expect(prisma.vehicle.create).toHaveBeenCalledTimes(1);
    });
  });
});
