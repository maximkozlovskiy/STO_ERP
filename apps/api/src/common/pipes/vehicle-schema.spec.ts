import { describe, it, expect } from 'vitest';
import { vehicleCreateSchema, vehicleUpdateSchema } from '@sto/shared';

const GARAGE = '11111111-1111-4111-8111-111111111111';
// Марка й модель — ідентифікатори довідника (BR-VEH-008), назву пише сервіс.
const MAKE = '22222222-2222-4222-8222-222222222222';
const MODEL = '33333333-3333-4333-8333-333333333333';

describe('vehicleCreateSchema (спільна, web ↔ api)', () => {
  it('приймає мінімальний валідний авто (garage+make+model)', () => {
    const r = vehicleCreateSchema.safeParse({
      customerGarageId: GARAGE,
      makeId: MAKE,
      modelId: MODEL,
    });
    expect(r.success).toBe(true);
  });

  it('відхиляє без марки/моделі укр. повідомленням', () => {
    const r = vehicleCreateSchema.safeParse({ customerGarageId: GARAGE, makeId: '', modelId: '' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => i.message === 'v.vehicle.make.required')).toBe(true);
      expect(r.error.issues.some(i => i.message === 'v.vehicle.model.required')).toBe(true);
    }
  });

  it('відхиляє без гаража', () => {
    const r = vehicleCreateSchema.safeParse({ makeId: MAKE, modelId: MODEL });
    expect(r.success).toBe(false);
  });

  it("коерсить рік/пробіг з рядка; '' → undefined", () => {
    const r = vehicleCreateSchema.safeParse({
      customerGarageId: GARAGE,
      makeId: MAKE,
      modelId: MODEL,
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
      makeId: MAKE,
      modelId: MODEL,
      currentMileage: '-5',
    });
    expect(r.success).toBe(false);
  });

  it('update — усі поля опційні (порожній обʼєкт ok), без customerGarageId', () => {
    expect(vehicleUpdateSchema.safeParse({}).success).toBe(true);
    // customerGarageId у update-схемі відсутній → whitelist не пропустить (zod ігнорує зайве)
    const r = vehicleUpdateSchema.safeParse({ year: '2020' });
    expect(r.success).toBe(true);
    if (r.success) expect('customerGarageId' in r.data).toBe(false);
  });
});
