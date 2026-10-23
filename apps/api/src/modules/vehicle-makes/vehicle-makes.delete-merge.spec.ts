import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ORG,
  makesService,
  modelsService,
  vehicleDirectoryWorld,
  type VehicleDirectoryWorld,
} from './vehicle-makes.spec-fixture';

/**
 * Видалення, відновлення й злиття марок і моделей. Довідник і авто — у пам'яті з виконанням
 * `where` (`vehicle-makes.spec-fixture.ts`): «живі авто» й «разом із видаленими» рахуються на рядках.
 */
describe('VehicleMakesService / VehicleModelsService — видалення і злиття (BR-VEH-009…011)', () => {
  let w: VehicleDirectoryWorld;
  beforeEach(() => {
    w = vehicleDirectoryWorld();
  });

  describe('видалення', () => {
    // guards: BR-VEH-009
    it('марку з живим авто не видалити — 400 з пропозицією злити, марка лишається', async () => {
      const make = w.addMake('Toyota');
      const model = w.addModel(make.id as string, 'Camry');
      w.addVehicle(make, model);
      const err = await makesService(w)
        .remove(ORG, make.id as string)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toMatch(/Злийте/);
      expect(make.deletedAt).toBeNull();
      expect(model.deletedAt).toBeNull();
    });

    // guards: BR-VEH-009
    it('марка лише з видаленими авто видаляється разом із живими моделями', async () => {
      const make = w.addMake('Daewoo');
      const lanos = w.addModel(make.id as string, 'Lanos');
      w.addVehicle(make, lanos, { deletedAt: new Date('2026-09-01') });

      await makesService(w).remove(ORG, make.id as string);

      expect(make.deletedAt).toBeInstanceOf(Date);
      expect(lanos.deletedAt).toEqual(make.deletedAt);
    });

    // guards: BR-VEH-009
    it('відновлення марки повертає моделі, видалені разом із нею, але не видалені раніше', async () => {
      const make = w.addMake('Daewoo');
      const lanos = w.addModel(make.id as string, 'Lanos');
      const earlier = w.addModel(make.id as string, 'Nexia', {
        deletedAt: new Date('2026-01-01'),
      });
      await makesService(w).remove(ORG, make.id as string);

      const restored = await makesService(w).restore(ORG, make.id as string);

      expect(restored.deletedAt).toBeNull();
      expect(lanos.deletedAt).toBeNull();
      expect(earlier.deletedAt).toEqual(new Date('2026-01-01'));
    });

    // guards: BR-VEH-009
    it('модель із живим авто не видалити; лише з видаленими — видаляється', async () => {
      const make = w.addMake('Opel');
      const astra = w.addModel(make.id as string, 'Astra');
      const vectra = w.addModel(make.id as string, 'Vectra');
      w.addVehicle(make, astra);
      w.addVehicle(make, vectra, { deletedAt: new Date('2026-09-01') });

      await expect(modelsService(w).remove(ORG, astra.id as string)).rejects.toThrow(/Злийте/);
      await modelsService(w).remove(ORG, vectra.id as string);

      expect(astra.deletedAt).toBeNull();
      expect(vectra.deletedAt).toBeInstanceOf(Date);
    });

    // guards: BR-VEH-009
    it('лічильник авто у списку марок — лише живі авто', async () => {
      const make = w.addMake('Skoda');
      const octavia = w.addModel(make.id as string, 'Octavia');
      w.addVehicle(make, octavia);
      w.addVehicle(make, octavia, { deletedAt: new Date('2026-09-01') });
      w.addModel(make.id as string, 'Fabia', { deletedAt: new Date('2026-09-01') });

      const { items } = await makesService(w).findAll(ORG);

      expect(items).toEqual([
        { id: make.id, name: 'Skoda', vehicleCount: 1, modelCount: 1, deletedAt: null },
      ]);
    });
  });

  describe('злиття марок', () => {
    // guards: BR-VEH-010, BR-VEH-011
    it('авто й моделі переходять до цілі; модель з тим самим ключем зливається; джерело видалено', async () => {
      const typo = w.addMake('Тойота');
      const toyota = w.addMake('Toyota');
      const typoCamry = w.addModel(typo.id as string, 'camry');
      const typoRav = w.addModel(typo.id as string, 'RAV4');
      const camry = w.addModel(toyota.id as string, 'Camry');
      const a = w.addVehicle(typo, typoCamry);
      const b = w.addVehicle(typo, typoRav, { deletedAt: new Date('2026-09-01') });

      const result = await makesService(w).merge(ORG, typo.id as string, toyota.id as string);

      expect(result).toMatchObject({ id: toyota.id, name: 'Toyota' });
      // Модель із ключем, що вже є в цілі, — злита: авто на моделі цілі, з її назвою.
      expect(a).toMatchObject({
        makeId: toyota.id,
        modelId: camry.id,
        make: 'Toyota',
        model: 'Camry',
      });
      expect(typoCamry.deletedAt).toBeInstanceOf(Date);
      // Решта моделей переходить до цілі, а з нею й авто — разом із видаленими.
      expect(typoRav).toMatchObject({ makeId: toyota.id, deletedAt: null });
      expect(b).toMatchObject({ makeId: toyota.id, modelId: typoRav.id, make: 'Toyota' });
      expect(typo.deletedAt).toBeInstanceOf(Date);
      expect(w.vehicles.rows.filter(v => v.makeId === typo.id)).toHaveLength(0);
    });

    // guards: BR-VEH-010
    it('жива модель джерела зливається з ВИДАЛЕНОЮ моделлю цілі — та оживає', async () => {
      const src = w.addMake('Mercedes');
      const dst = w.addMake('Mercedes-Benz');
      const srcE = w.addModel(src.id as string, 'E-Class');
      const dstE = w.addModel(dst.id as string, 'e-class', { deletedAt: new Date('2026-01-01') });
      const car = w.addVehicle(src, srcE);

      await makesService(w).merge(ORG, src.id as string, dst.id as string);

      expect(dstE.deletedAt).toBeNull();
      expect(car).toMatchObject({ makeId: dst.id, modelId: dstE.id, model: 'e-class' });
    });

    // guards: BR-VEH-010
    it('злиття із собою → 400, у видалену чи відсутню марку → 404; нічого не змінюється', async () => {
      const a = w.addMake('Lada');
      const gone = w.addMake('VAZ', { deletedAt: new Date('2026-01-01') });
      const model = w.addModel(a.id as string, '2107');
      const car = w.addVehicle(a, model);

      await expect(makesService(w).merge(ORG, a.id as string, a.id as string)).rejects.toThrow(
        /саму з собою/,
      );
      await expect(
        makesService(w).merge(ORG, a.id as string, gone.id as string),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(car.makeId).toBe(a.id);
      expect(a.deletedAt).toBeNull();
    });
  });

  describe('злиття моделей', () => {
    // guards: BR-VEH-010, BR-VEH-011
    it('авто моделі, разом із видаленими, переходять на ціль з її назвою; джерело видалено', async () => {
      const make = w.addMake('BMW');
      const typo = w.addModel(make.id as string, 'X 5');
      const x5 = w.addModel(make.id as string, 'X5');
      const live = w.addVehicle(make, typo);
      const deleted = w.addVehicle(make, typo, { deletedAt: new Date('2026-09-01') });

      const result = await modelsService(w).merge(ORG, typo.id as string, x5.id as string);

      expect(result).toMatchObject({ id: x5.id, vehicleCount: 1 });
      expect(live).toMatchObject({ modelId: x5.id, model: 'X5' });
      expect(deleted).toMatchObject({ modelId: x5.id, model: 'X5' });
      expect(typo.deletedAt).toBeInstanceOf(Date);
    });

    // guards: BR-VEH-010
    it('модель іншої марки — 400, авто не переносяться', async () => {
      const bmw = w.addMake('BMW');
      const audi = w.addMake('Audi');
      const x5 = w.addModel(bmw.id as string, 'X5');
      const q7 = w.addModel(audi.id as string, 'Q7');
      const car = w.addVehicle(bmw, x5);

      await expect(modelsService(w).merge(ORG, x5.id as string, q7.id as string)).rejects.toThrow(
        /однієї марки/,
      );
      expect(car.modelId).toBe(x5.id);
      expect(x5.deletedAt).toBeNull();
    });

    // guards: BR-VEH-010
    it('злиття моделі із собою → 400', async () => {
      const make = w.addMake('Kia');
      const rio = w.addModel(make.id as string, 'Rio');
      await expect(modelsService(w).merge(ORG, rio.id as string, rio.id as string)).rejects.toThrow(
        /саму з собою/,
      );
    });
  });
});
