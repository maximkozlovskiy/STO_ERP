import { describe, it, expect, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { modelMock, type PrismaModelMock } from '../../common/testing/prisma-mock';

/**
 * MaintenanceSchedulesService — модуль був БЕЗ тестів (аудит 2024-10: 12 таких модулів).
 *
 * Що тут справді варто стерегти (а не просто «покриття»):
 *  - **ліміт 200 id** у bulk-фільтрі `vehicleIds` — захист від того, що фронт пришле
 *    сотні id у CSV-параметрі; без тесту ліміт легко прибрати «рефакторингом»;
 *  - **`vehicle: { deletedAt: null }`** — вкладений фільтр: графік видаленого авто не
 *    має світитись у списку, і це НЕ те саме, що `deletedAt` самого графіка;
 *  - **soft-delete через `updateMany`** з `orgId` у `where` — атомарний 1-RTT патерн;
 *    hard `delete()` тут заборонений (CLAUDE.md §5);
 *  - **розрахунок дат через Kyiv-календар** (`addDaysKyiv`), а не server-local `setDate`:
 *    інакше на межі доби/переходу DST дата наступного ТО зсувається на ±1 день (CAL-M3);
 *  - **tenant isolation** — `orgId` у КОЖНОМУ запиті.
 */
describe('MaintenanceSchedulesService', () => {
  let svc: MaintenanceSchedulesService;
  let prisma: { maintenanceSchedule: PrismaModelMock; vehicle: PrismaModelMock };

  const ORG = 'org-1';
  const VEHICLE = 'veh-1';

  /** Рядок у формі, яку чекає toDto (include vehicle). */
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'ms-1',
    orgId: ORG,
    vehicleId: VEHICLE,
    maintenanceType: 'REGULAR',
    intervalDays: 180,
    intervalMileage: 10_000,
    lastMaintenanceDate: new Date('2026-01-10T00:00:00.000Z'),
    lastMaintenanceMileage: 50_000,
    nextMaintenanceDate: new Date('2026-07-09T00:00:00.000Z'),
    nextMaintenanceMileage: 60_000,
    isActive: true,
    notes: null,
    createdAt: new Date('2026-01-10T00:00:00.000Z'),
    updatedAt: new Date('2026-01-10T00:00:00.000Z'),
    vehicle: { make: 'VW', model: 'Passat', licensePlate: 'AA1234BB' },
    ...over,
  });

  beforeEach(() => {
    prisma = {
      maintenanceSchedule: modelMock(
        'findMany',
        'findFirst',
        'create',
        'update',
        'updateMany',
        'count',
      ),
      vehicle: modelMock('findFirst'),
    };
    prisma.maintenanceSchedule.findMany.mockResolvedValue([row()]);
    prisma.maintenanceSchedule.findFirst.mockResolvedValue(row());
    prisma.maintenanceSchedule.create.mockResolvedValue(row());
    prisma.maintenanceSchedule.update.mockResolvedValue(row());
    prisma.maintenanceSchedule.updateMany.mockResolvedValue({ count: 1 });
    prisma.vehicle.findFirst.mockResolvedValue({ id: VEHICLE });
    svc = new MaintenanceSchedulesService(prisma as never);
  });

  describe('findAll — bulk-фільтр і видалені авто', () => {
    it('vehicleIds обрізається до 200 (захист від сотень id у CSV-параметрі)', async () => {
      const ids = Array.from({ length: 250 }, (_, i) => `v-${i}`);
      await svc.findAll(ORG, undefined, ids);
      const where = prisma.maintenanceSchedule.findMany.mock.calls[0][0].where;
      expect(where.vehicleId.in).toHaveLength(200);
      expect(where.vehicleId.in[0]).toBe('v-0');
      expect(where.vehicleId.in[199]).toBe('v-199');
    });

    it('порожні значення у vehicleIds відкидаються до обрізання', async () => {
      await svc.findAll(ORG, undefined, ['a', '', 'b']);
      const where = prisma.maintenanceSchedule.findMany.mock.calls[0][0].where;
      expect(where.vehicleId.in).toEqual(['a', 'b']);
    });

    it('vehicleId (одиничний) має пріоритет над vehicleIds', async () => {
      await svc.findAll(ORG, VEHICLE, ['other-1', 'other-2']);
      const where = prisma.maintenanceSchedule.findMany.mock.calls[0][0].where;
      expect(where.vehicleId).toBe(VEHICLE);
    });

    it('порожній vehicleIds → без фільтра по авто (не `in: []`, що дало б 0 рядків)', async () => {
      await svc.findAll(ORG, undefined, []);
      const where = prisma.maintenanceSchedule.findMany.mock.calls[0][0].where;
      expect(where.vehicleId).toBeUndefined();
    });

    it('графік ВИДАЛЕНОГО авто не потрапляє у список (вкладений vehicle.deletedAt)', async () => {
      await svc.findAll(ORG);
      const where = prisma.maintenanceSchedule.findMany.mock.calls[0][0].where;
      // Два РІЗНІ фільтри: сам графік не видалений І його авто не видалене.
      expect(where.deletedAt).toBeNull();
      expect(where.vehicle).toEqual({ deletedAt: null });
    });
  });

  describe('findUpcoming — лише активні', () => {
    it('фільтрує isActive=true і межу nextMaintenanceDate (неактивні графіки не нагадують)', async () => {
      await svc.findUpcoming(ORG, 30);
      const where = prisma.maintenanceSchedule.findMany.mock.calls[0][0].where;
      expect(where.isActive).toBe(true);
      expect(where.nextMaintenanceDate.lte).toBeInstanceOf(Date);
      expect(where.vehicle).toEqual({ deletedAt: null });
    });
  });

  describe('create — FK-guard і розрахунок наступного ТО', () => {
    it('неіснуюче/видалене авто → 404 (графік не створюється)', async () => {
      prisma.vehicle.findFirst.mockResolvedValue(null);
      await expect(
        svc.create(ORG, { vehicleId: 'ghost', intervalDays: 30 } as never),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.maintenanceSchedule.create).not.toHaveBeenCalled();
    });

    it('FK-guard шукає авто у СВОЇЙ org і не видалене', async () => {
      await svc.create(ORG, { vehicleId: VEHICLE, intervalDays: 30 } as never);
      expect(prisma.vehicle.findFirst.mock.calls[0][0].where).toEqual({
        id: VEHICLE,
        orgId: ORG,
        deletedAt: null,
      });
    });

    it('дата наступного ТО = lastDate + intervalDays у КИЇВСЬКОМУ календарі', async () => {
      await svc.create(ORG, {
        vehicleId: VEHICLE,
        intervalDays: 180,
        lastMaintenanceDate: '2026-01-10',
      } as never);
      const data = prisma.maintenanceSchedule.create.mock.calls[0][0].data;
      // 10.01 + 180 днів = 09.07 (перехід на літній час у березні НЕ має зсунути дату).
      expect((data.nextMaintenanceDate as Date).toISOString().slice(0, 10)).toBe('2026-07-09');
    });

    it('без lastMaintenanceDate або без intervalDays → наступна дата null (не «сьогодні»)', async () => {
      await svc.create(ORG, { vehicleId: VEHICLE, intervalDays: 180 } as never);
      expect(
        prisma.maintenanceSchedule.create.mock.calls[0][0].data.nextMaintenanceDate,
      ).toBeNull();

      prisma.maintenanceSchedule.create.mockClear();
      await svc.create(ORG, { vehicleId: VEHICLE, lastMaintenanceDate: '2026-01-10' } as never);
      expect(
        prisma.maintenanceSchedule.create.mock.calls[0][0].data.nextMaintenanceDate,
      ).toBeNull();
    });

    it('пробіг наступного ТО = останній + інтервал; без одного з них → null', async () => {
      await svc.create(ORG, {
        vehicleId: VEHICLE,
        intervalMileage: 10_000,
        lastMaintenanceMileage: 50_000,
      } as never);
      expect(prisma.maintenanceSchedule.create.mock.calls[0][0].data.nextMaintenanceMileage).toBe(
        60_000,
      );

      prisma.maintenanceSchedule.create.mockClear();
      await svc.create(ORG, { vehicleId: VEHICLE, intervalMileage: 10_000 } as never);
      expect(
        prisma.maintenanceSchedule.create.mock.calls[0][0].data.nextMaintenanceMileage,
      ).toBeNull();
    });

    it('maintenanceType за замовчуванням REGULAR, orgId із контексту', async () => {
      await svc.create(ORG, { vehicleId: VEHICLE, intervalDays: 30 } as never);
      const data = prisma.maintenanceSchedule.create.mock.calls[0][0].data;
      expect(data.maintenanceType).toBe('REGULAR');
      expect(data.orgId).toBe(ORG);
    });
  });

  describe('remove — soft delete, не hard', () => {
    it('updateMany з deletedAt (CLAUDE.md §5: hard delete заборонений)', async () => {
      await svc.remove(ORG, 'ms-1');
      const call = prisma.maintenanceSchedule.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'ms-1', orgId: ORG, deletedAt: null });
      expect(call.data.deletedAt).toBeInstanceOf(Date);
      // Саме updateMany, а не delete — модель має deletedAt.
      expect(prisma.maintenanceSchedule.delete).toBeUndefined();
    });

    it('count=0 (чужа org або вже видалено) → 404', async () => {
      prisma.maintenanceSchedule.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.remove(ORG, 'ms-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateAfterWorkOrder — перерахунок після закритого наряду', () => {
    it('бере лише активні графіки свого авто й org', async () => {
      prisma.maintenanceSchedule.findMany.mockResolvedValue([]);
      await svc.updateAfterWorkOrder(ORG, VEHICLE, new Date('2026-03-01'));
      expect(prisma.maintenanceSchedule.findMany.mock.calls[0][0].where).toEqual({
        orgId: ORG,
        vehicleId: VEHICLE,
        deletedAt: null,
        isActive: true,
      });
    });

    it('без пробігу в наряді — беремо попередній пробіг графіка (не скидаємо в null)', async () => {
      prisma.maintenanceSchedule.findMany.mockResolvedValue([
        { id: 'ms-1', intervalDays: 180, intervalMileage: 10_000, lastMaintenanceMileage: 50_000 },
      ]);
      await svc.updateAfterWorkOrder(ORG, VEHICLE, new Date('2026-03-01T00:00:00.000Z'));
      const data = prisma.maintenanceSchedule.update.mock.calls[0][0].data;
      // mileage не передано → lastMaintenanceMileage НЕ перезаписується…
      expect(data.lastMaintenanceMileage).toBeUndefined();
      // …але наступний пробіг рахується від збереженого (50 000 + 10 000).
      expect(data.nextMaintenanceMileage).toBe(60_000);
    });

    it('з пробігом — перезаписує останній і рахує наступний від нього', async () => {
      prisma.maintenanceSchedule.findMany.mockResolvedValue([
        { id: 'ms-1', intervalDays: null, intervalMileage: 10_000, lastMaintenanceMileage: 50_000 },
      ]);
      await svc.updateAfterWorkOrder(ORG, VEHICLE, new Date('2026-03-01'), 72_000);
      const data = prisma.maintenanceSchedule.update.mock.calls[0][0].data;
      expect(data.lastMaintenanceMileage).toBe(72_000);
      expect(data.nextMaintenanceMileage).toBe(82_000);
      // intervalDays=null → дати наступного ТО немає.
      expect(data.nextMaintenanceDate).toBeNull();
    });

    it('кілька графіків оновлюються паралельно, кожен із orgId у where', async () => {
      prisma.maintenanceSchedule.findMany.mockResolvedValue([
        { id: 'ms-1', intervalDays: 180, intervalMileage: null, lastMaintenanceMileage: null },
        { id: 'ms-2', intervalDays: 365, intervalMileage: null, lastMaintenanceMileage: null },
      ]);
      await svc.updateAfterWorkOrder(ORG, VEHICLE, new Date('2026-03-01'));
      expect(prisma.maintenanceSchedule.update).toHaveBeenCalledTimes(2);
      for (const call of prisma.maintenanceSchedule.update.mock.calls) {
        expect(call[0].where.orgId).toBe(ORG);
      }
    });

    it('немає активних графіків → жодного update (не падає)', async () => {
      prisma.maintenanceSchedule.findMany.mockResolvedValue([]);
      await expect(
        svc.updateAfterWorkOrder(ORG, VEHICLE, new Date('2026-03-01')),
      ).resolves.toBeUndefined();
      expect(prisma.maintenanceSchedule.update).not.toHaveBeenCalled();
    });
  });

  describe('tenant isolation', () => {
    it('orgId присутній у where КОЖНОГО читання', async () => {
      await svc.findAll(ORG);
      await svc.findOne(ORG, 'ms-1');
      await svc.findUpcoming(ORG, 30);
      for (const call of [
        ...prisma.maintenanceSchedule.findMany.mock.calls,
        ...prisma.maintenanceSchedule.findFirst.mock.calls,
      ]) {
        expect(call[0].where.orgId).toBe(ORG);
      }
    });

    it('findOne чужого графіка → 404 (не 200 з даними іншої org)', async () => {
      prisma.maintenanceSchedule.findFirst.mockResolvedValue(null);
      await expect(svc.findOne(ORG, 'foreign')).rejects.toThrow(NotFoundException);
    });
  });
});
