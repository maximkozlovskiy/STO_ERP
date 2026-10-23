import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, it, expect, beforeEach } from 'vitest';
import { vehicleMakeSchema, vehicleModelSchema } from '@sto/shared';
import {
  ORG,
  OTHER_ORG,
  makesService,
  modelsService,
  vehicleDirectoryWorld,
  type VehicleDirectoryWorld,
} from './vehicle-makes.spec-fixture';

/**
 * Назви довідника марок і моделей: ключ унікальності, перейменування та знімок назви в авто.
 * Довідник і авто — у пам'яті з виконанням `where` (`vehicle-makes.spec-fixture.ts`).
 */
describe('VehicleMakesService / VehicleModelsService — назви (BR-VEH-006, 007, 011)', () => {
  let w: VehicleDirectoryWorld;
  beforeEach(() => {
    w = vehicleDirectoryWorld();
  });

  describe('марка: ключ назви', () => {
    // guards: BR-VEH-006
    it('назва нормалізується (пробіли), ключ — у нижньому регістрі', async () => {
      const dto = vehicleMakeSchema.parse({ name: '  Land   Rover ' });
      const made = await makesService(w).create(ORG, dto);
      expect(made.name).toBe('Land Rover');
      expect(w.makes.rows.find(r => r.id === made.id)?.nameKey).toBe('land rover');
    });

    // guards: BR-VEH-006
    it('та сама назва в іншому регістрі й з пробілами → 409 «вже є», нового рядка немає', async () => {
      w.addMake('Toyota');
      const dto = vehicleMakeSchema.parse({ name: ' TOYOTA ' });
      await expect(makesService(w).create(ORG, dto)).rejects.toThrow(/вже є/);
      await expect(makesService(w).create(ORG, dto)).rejects.toBeInstanceOf(ConflictException);
      expect(w.makes.rows).toHaveLength(1);
    });

    // guards: BR-VEH-006
    it('назва видаленої марки → 409 «серед видалених — відновіть», а не друга марка', async () => {
      w.addMake('Ferrari', { deletedAt: new Date('2026-10-01') });
      await expect(makesService(w).create(ORG, { name: 'ferrari' })).rejects.toThrow(
        /серед видалених/,
      );
      expect(w.makes.rows).toHaveLength(1);
    });

    // guards: BR-VEH-006
    it('та сама назва в ІНШІЙ організації не заважає', async () => {
      w.addMake('Toyota', { orgId: OTHER_ORG });
      const made = await makesService(w).create(ORG, { name: 'Toyota' });
      expect(made.name).toBe('Toyota');
      expect(w.makes.rows.filter(r => r.orgId === ORG)).toHaveLength(1);
    });

    // guards: BR-VEH-006
    it('перейменування в назву іншої марки → 409; у свою ж в іншому регістрі — можна', async () => {
      const bmw = w.addMake('Bmw');
      w.addMake('Audi');
      await expect(makesService(w).rename(ORG, bmw.id as string, { name: 'AUDI' })).rejects.toThrow(
        /вже є/,
      );
      const renamed = await makesService(w).rename(ORG, bmw.id as string, { name: 'BMW' });
      expect(renamed.name).toBe('BMW');
    });

    // guards: BR-VEH-006
    it('перейменування в назву видаленої марки → 409 «серед видалених»', async () => {
      const kia = w.addMake('Kia');
      w.addMake('Daewoo', { deletedAt: new Date('2026-10-01') });
      await expect(
        makesService(w).rename(ORG, kia.id as string, { name: 'daewoo' }),
      ).rejects.toThrow(/серед видалених/);
    });

    it('запис іде під ексклюзивним блокуванням довідника організації', async () => {
      await makesService(w).create(ORG, { name: 'Haval' });
      expect(w.locks).toHaveLength(1);
      expect(w.locks[0]).toMatch(/pg_advisory_xact_lock\(/);
      expect(w.locks[0]).not.toMatch(/_shared/);
    });
  });

  describe('модель: ключ назви в межах марки', () => {
    // guards: BR-VEH-007
    it('та сама модель у марці → 409; така ж назва в ІНШІЙ марці — можна', async () => {
      const toyota = w.addMake('Toyota');
      const lexus = w.addMake('Lexus');
      w.addModel(toyota.id as string, 'Camry');
      const dto = vehicleModelSchema.parse({ name: ' camry ' });
      await expect(modelsService(w).create(ORG, toyota.id as string, dto)).rejects.toThrow(/вже є/);
      const other = await modelsService(w).create(ORG, lexus.id as string, dto);
      expect(other).toMatchObject({ makeId: lexus.id, name: 'camry' });
    });

    // guards: BR-VEH-007
    it('назва видаленої моделі цієї марки → 409 «серед видалених»', async () => {
      const toyota = w.addMake('Toyota');
      w.addModel(toyota.id as string, 'Corolla', { deletedAt: new Date('2026-10-01') });
      await expect(
        modelsService(w).create(ORG, toyota.id as string, { name: 'COROLLA' }),
      ).rejects.toThrow(/серед видалених/);
    });

    // guards: BR-VEH-007
    it('модель видаленої марки не створюється й не відновлюється', async () => {
      const gone = w.addMake('Ravon', { deletedAt: new Date('2026-10-01') });
      const r2 = w.addModel(gone.id as string, 'R2', { deletedAt: new Date('2026-10-01') });
      await expect(
        modelsService(w).create(ORG, gone.id as string, { name: 'Gentra' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(modelsService(w).restore(ORG, r2.id as string)).rejects.toThrow(
        /спершу відновіть марку/,
      );
      expect(r2.deletedAt).not.toBeNull();
    });

    // guards: BR-VEH-007
    it('марка чужої організації — 404, модель не створюється', async () => {
      const foreign = w.addMake('Toyota', { orgId: OTHER_ORG });
      await expect(
        modelsService(w).create(ORG, foreign.id as string, { name: 'Camry' }),
      ).rejects.toThrow(/не знайдено/);
      expect(w.models.rows).toHaveLength(0);
    });

    // guards: BR-VEH-007
    it('перейменування моделі в назву іншої моделі тієї ж марки → 409', async () => {
      const vw = w.addMake('Volkswagen');
      const golf = w.addModel(vw.id as string, 'Golf');
      w.addModel(vw.id as string, 'Passat');
      await expect(
        modelsService(w).rename(ORG, golf.id as string, { name: 'passat' }),
      ).rejects.toThrow(/вже є/);
    });
  });

  describe('знімок назви в авто', () => {
    // guards: BR-VEH-011
    it('перейменування марки пише нову назву в УСІ її авто, разом із видаленими; чужі — ні', async () => {
      const make = w.addMake('Toyta');
      const model = w.addModel(make.id as string, 'Camry');
      const other = w.addMake('Honda');
      const civic = w.addModel(other.id as string, 'Civic');
      const live = w.addVehicle(make, model);
      const deleted = w.addVehicle(make, model, { deletedAt: new Date('2026-09-01') });
      const foreign = w.addVehicle(other, civic);

      await makesService(w).rename(ORG, make.id as string, { name: 'Toyota' });

      expect(live.make).toBe('Toyota');
      expect(deleted.make).toBe('Toyota');
      expect(foreign.make).toBe('Honda');
      expect(live.model).toBe('Camry');
    });

    // guards: BR-VEH-011
    it('перейменування моделі пише нову назву в усі її авто, разом із видаленими', async () => {
      const make = w.addMake('Toyota');
      const model = w.addModel(make.id as string, 'Camri');
      const sibling = w.addModel(make.id as string, 'Corolla');
      const live = w.addVehicle(make, model);
      const deleted = w.addVehicle(make, model, { deletedAt: new Date('2026-09-01') });
      const untouched = w.addVehicle(make, sibling);

      await modelsService(w).rename(ORG, model.id as string, { name: 'Camry' });

      expect(live.model).toBe('Camry');
      expect(deleted.model).toBe('Camry');
      expect(untouched.model).toBe('Corolla');
    });

    it('після запису довідника кеш списку марок скидається', async () => {
      await makesService(w).create(ORG, { name: 'Geely' });
      expect(w.cache.del).toHaveBeenCalledWith(`ref:vehicle-makes:${ORG}`);
    });
  });
});
