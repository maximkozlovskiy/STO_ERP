import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { VehiclesService } from './vehicles.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import type { PrismaModelMock } from '../../common/testing/prisma-mock';

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
    vehicle: PrismaModelMock;
    customerGarage: PrismaModelMock;
    vehicleNode: PrismaModelMock;
    workOrder: PrismaModelMock;
    // BR-CP-015: create / restore блокують рядок гаража в транзакції.
    $queryRaw: ReturnType<typeof vi.fn>;
    $transaction: ReturnType<typeof vi.fn>;
    // BR-VEH-008: create бере спільне блокування довідника й читає назви марки та моделі.
    $executeRaw: ReturnType<typeof vi.fn>;
    vehicleMake: PrismaModelMock;
    vehicleModel: PrismaModelMock;
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
      // A2: guard рахує активні наряди перед видаленням авто. За замовч. 0 (немає активних).
      workOrder: {
        count: vi.fn().mockResolvedValue(0),
      },
      customerGarage: {
        findFirst: vi.fn(),
      },
      // BR-CP-015: create блокує рядок гаража (FOR SHARE) у транзакції зі вставкою авто.
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'g-1' }]),
      $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
      $executeRaw: vi.fn().mockResolvedValue(1),
      vehicleMake: { findFirst: vi.fn().mockResolvedValue({ name: 'Toyota' }) },
      vehicleModel: { findFirst: vi.fn().mockResolvedValue({ name: 'Camry', makeId: 'mk-1' }) },
      vehicleNode: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
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

    it('A2: авто з активними нарядами → BadRequest, updateMany НЕ викликається', async () => {
      prisma.workOrder.count.mockResolvedValueOnce(2); // 2 активні наряди на це авто
      await expect(service.remove('org-1', 'veh-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
      // guard рахує наряди не-термінальних статусів (tenant-scoped orgId + vehicleId).
      expect(prisma.workOrder.count.mock.calls[0][0].where).toMatchObject({
        orgId: 'org-1',
        vehicleId: 'veh-1',
        deletedAt: null,
        status: { notIn: ['ARCHIVED', 'CANCELLED'] },
      });
      // MUTATION-VERIFY: прибрати guard → updateMany викликається → перший assert впаде (orphaned WO).
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
      customerGarageId: 'g-1',
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
      prisma.vehicle.findFirst.mockResolvedValueOnce({ id: 'other' }); // VIN clash
      await expect(
        service.create('org-1', {
          customerGarageId: 'g-1',
          makeId: 'mk-1',
          modelId: 'md-1',
          vin: 'WVWZZZ',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.vehicle.create).not.toHaveBeenCalled();
    });

    it('create з унікальним VIN → створює', async () => {
      prisma.vehicle.findFirst.mockResolvedValueOnce(null); // no clash
      prisma.vehicle.create.mockResolvedValueOnce({ id: 'v-1', customerGarageId: 'g-1' });
      await service.create('org-1', {
        customerGarageId: 'g-1',
        makeId: 'mk-1',
        modelId: 'md-1',
        vin: 'UNIQUE1',
      } as never);
      expect(prisma.vehicle.create).toHaveBeenCalledTimes(1);
      // VIN-lookup виключає deletedAt (лише активні дублі).
      const vinCall = prisma.vehicle.findFirst.mock.calls[0][0];
      expect(vinCall.where).toMatchObject({ orgId: 'org-1', vin: 'UNIQUE1', deletedAt: null });
    });

    it('create без VIN → перевірка пропускається', async () => {
      prisma.vehicle.create.mockResolvedValueOnce({ id: 'v-1', customerGarageId: 'g-1' });
      await service.create('org-1', {
        customerGarageId: 'g-1',
        makeId: 'mk-1',
        modelId: 'md-1',
      } as never);
      expect(prisma.vehicle.create).toHaveBeenCalledTimes(1);
    });
  });

  // BR-CP-015 (TECH-DEBT §17.2): гонка «видалення гаража ↔ створення авто».
  describe('create — гараж блокується до вставки авто', () => {
    it('рядок гаража читається FOR SHARE у тій самій транзакції, що й вставка', async () => {
      prisma.vehicle.create.mockResolvedValueOnce({ id: 'v-1', customerGarageId: 'g-1' });
      await service.create('org-1', {
        customerGarageId: 'g-1',
        makeId: 'mk-1',
        modelId: 'md-1',
      } as never);
      const sql = (prisma.$queryRaw.mock.calls[0]![0] as TemplateStringsArray).join('?');
      expect(sql).toMatch(/FROM customer_garages/);
      expect(sql).toMatch(/"deletedAt" IS NULL/);
      expect(sql).toMatch(/FOR SHARE/);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('гараж уже видалено (блокування не повернуло рядка) → 404, авто не створюється', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await expect(
        service.create('org-1', {
          customerGarageId: 'g-1',
          makeId: 'mk-1',
          modelId: 'md-1',
        } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.vehicle.create).not.toHaveBeenCalled();
    });
  });

  // BR-CP-015 (Bug #949): відновлення — теж шлях, яким авто з'являється в гаражі.
  describe('restore — гараж блокується до відновлення авто', () => {
    const deletedVehicle = {
      deletedAt: new Date('2026-01-01T00:00:00Z'),
      customerGarageId: 'g-1',
      customerGarage: { deletedAt: null, counterparty: { deletedAt: null } },
    };

    it('рядок гаража авто читається FOR SHARE у транзакції, що відновлює авто', async () => {
      prisma.vehicle.findFirst.mockResolvedValueOnce(deletedVehicle);
      prisma.vehicle.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.vehicle.findFirstOrThrow.mockResolvedValueOnce(rawVehicle({ deletedAt: null }));
      await service.restore('org-1', 'veh-1');
      const call = prisma.$queryRaw.mock.calls[0]!;
      const sql = (call[0] as TemplateStringsArray).join('?');
      expect(sql).toMatch(/FROM customer_garages/);
      expect(sql).toMatch(/"deletedAt" IS NULL/);
      expect(sql).toMatch(/FOR SHARE/);
      expect(call.slice(1)).toEqual(['g-1', 'org-1']);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('гараж видалили між перевіркою і записом (блокування без рядка) → 400, авто не відновлюється', async () => {
      prisma.vehicle.findFirst.mockResolvedValueOnce(deletedVehicle);
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await expect(service.restore('org-1', 'veh-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
    });
  });

  // BR-VEH-014: відновлене авто — живе, тож його марка й модель мусять бути живими (BR-VEH-008).
  describe('restore — марка й модель авто живі (BR-VEH-014)', () => {
    const deletedVehicle = {
      deletedAt: new Date('2026-01-01T00:00:00Z'),
      customerGarageId: 'g-1',
      customerGarage: { deletedAt: null, counterparty: { deletedAt: null } },
    };
    const pairState = (makeDeleted: Date | null, modelDeleted: Date | null) => ({
      vehicleMake: { deletedAt: makeDeleted },
      vehicleModel: { deletedAt: modelDeleted },
    });
    const restoreWithPair = (pair: ReturnType<typeof pairState>) => {
      prisma.vehicle.findFirst.mockResolvedValueOnce(deletedVehicle).mockResolvedValueOnce(pair);
      prisma.vehicle.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.vehicle.findFirstOrThrow.mockResolvedValueOnce(rawVehicle({ deletedAt: null }));
      return service.restore('org-1', 'veh-1');
    };

    // guards: BR-VEH-014
    it('марку авто видалено → 400 «спершу відновіть», авто не відновлюється', async () => {
      await expect(restoreWithPair(pairState(new Date('2026-02-01'), null))).rejects.toThrow(
        /Марку чи модель цього авто видалено/,
      );
      expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
    });

    // guards: BR-VEH-014
    it('модель авто видалено (марка жива) → 400, авто не відновлюється', async () => {
      await expect(restoreWithPair(pairState(null, new Date('2026-02-01')))).rejects.toThrow(
        /Марку чи модель цього авто видалено/,
      );
      expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
    });

    // guards: BR-VEH-014
    it('пара читається в транзакції під спільним блокуванням довідника, до гаража; обидві живі → відновлено', async () => {
      const res = await restoreWithPair(pairState(null, null));
      expect(res.deletedAt).toBeNull();
      const pairRead = prisma.vehicle.findFirst.mock.calls[1]![0];
      expect(pairRead.where).toEqual({ id: 'veh-1', orgId: 'org-1' });
      expect(pairRead.select.vehicleMake.select.deletedAt).toBe(true);
      expect(pairRead.select.vehicleModel.select.deletedAt).toBe(true);
      const lockSql = (prisma.$executeRaw.mock.calls[0]![0] as TemplateStringsArray).join('?');
      expect(lockSql).toMatch(/pg_advisory_xact_lock_shared\(/);
      const lockAt = prisma.$executeRaw.mock.invocationCallOrder[0]!;
      expect(lockAt).toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[0]!);
      expect(lockAt).toBeLessThan(prisma.vehicle.findFirst.mock.invocationCallOrder[1]!);
      expect(prisma.vehicle.updateMany).toHaveBeenCalledTimes(1);
    });
  });
});
