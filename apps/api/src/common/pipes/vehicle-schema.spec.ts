import { describe, it, expect } from 'vitest';
import { vehicleCreateSchema, vehicleUpdateSchema } from '@sto/shared';

const GARAGE = '11111111-1111-1111-1111-111111111111';

describe('vehicleCreateSchema (спільна, web ↔ api)', () => {
  it('приймає мінімальний валідний авто (garage+make+model)', () => {
    const r = vehicleCreateSchema.safeParse({ customerGarageId: GARAGE, make: 'BMW', model: 'X5' });
    expect(r.success).toBe(true);
  });

  it('відхиляє без марки/моделі укр. повідомленням', () => {
    const r = vehicleCreateSchema.safeParse({ customerGarageId: GARAGE, make: '', model: '' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => i.message === 'v.vehicle.make.required')).toBe(true);
      expect(r.error.issues.some(i => i.message === 'v.vehicle.model.required')).toBe(true);
    }
  });

  it('відхиляє без гаража', () => {
    const r = vehicleCreateSchema.safeParse({ make: 'BMW', model: 'X5' });
    expect(r.success).toBe(false);
  });

  it("коерсить рік/пробіг з рядка; '' → undefined", () => {
    const r = vehicleCreateSchema.safeParse({
      customerGarageId: GARAGE,
      make: 'BMW',
      model: 'X5',
      year: '2015',
      currentMileage: '120000',
      engineVolume: '',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.year).toBe(2015);
      expect(r.data.currentMileage).toBe(120000);
      expect(r.data.engineVolume).toBeUndefined();
    }
  });

  it("відхиляє від'ємний пробіг", () => {
    const r = vehicleCreateSchema.safeParse({
      customerGarageId: GARAGE,
      make: 'BMW',
      model: 'X5',
      currentMileage: '-5',
    });
    expect(r.success).toBe(false);
  });

  it('update — усі поля опційні (порожній обʼєкт ok), без customerGarageId', () => {
    expect(vehicleUpdateSchema.safeParse({}).success).toBe(true);
    // customerGarageId у update-схемі відсутній → whitelist не пропустить (zod ігнорує зайве)
    const r = vehicleUpdateSchema.safeParse({ make: 'Audi' });
    expect(r.success).toBe(true);
    if (r.success) expect('customerGarageId' in r.data).toBe(false);
  });
});
