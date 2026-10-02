import { describe, it, expect } from 'vitest';
import {
  vehicleCreateSchema,
  vehicleUpdateSchema,
  vehicleFormSchema,
  counterpartyFormSchema,
  counterpartyUpdateSchema,
} from '@sto/shared';

const GARAGE = '11111111-1111-4111-8111-111111111111';

/**
 * Контракт спільних zod-схем Vehicle/Counterparty (web ↔ api) — Фаза 2.
 * Ловить регресії валідації, коли ZodValidationPipe заміняє class-validator DTO:
 * поле, що раніше мало @IsDateString()/@IsInt()@Min/@Max, не повинно тихо пропускати сміття.
 */
describe('vehicleFormSchema / vehicleCreate / vehicleUpdate', () => {
  // Bug #753 — дати мусять валідуватись (інакше сміття летить у Prisma DateTime → 500).
  it('невалідна insuranceExpiry → помилка (не пропускає у Prisma)', () => {
    const r = vehicleUpdateSchema.safeParse({ insuranceExpiry: 'not-a-date' });
    expect(r.success).toBe(false);
  });
  it('невалідна inspectionExpiry на create → помилка', () => {
    const r = vehicleCreateSchema.safeParse({
      customerGarageId: GARAGE,
      make: 'A',
      model: 'B',
      inspectionExpiry: 'garbage',
    });
    expect(r.success).toBe(false);
  });
  it('валідна YYYY-MM-DD та повний ISO проходять; порожня → undefined', () => {
    expect(vehicleUpdateSchema.safeParse({ insuranceExpiry: '2025-01-01' }).success).toBe(true);
    expect(
      vehicleUpdateSchema.safeParse({ insuranceExpiry: '2025-01-01T00:00:00.000Z' }).success,
    ).toBe(true);
    const empty = vehicleUpdateSchema.parse({ insuranceExpiry: '' });
    expect(empty.insuranceExpiry).toBeUndefined();
  });

  // Bug #754 — рік у розумному діапазоні (регресія прибраного HTML min=1900 max=2100).
  it('рік поза діапазоном (50 / -100 / 999999) → помилка', () => {
    expect(vehicleUpdateSchema.safeParse({ year: '50' }).success).toBe(false);
    expect(vehicleUpdateSchema.safeParse({ year: '-100' }).success).toBe(false);
    expect(vehicleUpdateSchema.safeParse({ year: '999999' }).success).toBe(false);
  });
  it('рік у діапазоні → коерсія у number; порожній → undefined', () => {
    expect(vehicleUpdateSchema.parse({ year: '2015' }).year).toBe(2015);
    expect(vehicleUpdateSchema.parse({ year: '' }).year).toBeUndefined();
  });

  // Гараж: форма опційна (резолвиться батьком), create — обовʼязковий UUID.
  it('create без гаража → помилка; форма без гаража → OK', () => {
    expect(vehicleCreateSchema.safeParse({ make: 'BMW', model: 'X5' }).success).toBe(false);
    expect(vehicleFormSchema.safeParse({ make: 'BMW', model: 'X5', year: '2020' }).success).toBe(
      true,
    );
  });

  it('коерсія engineVolume/currentMileage; відʼємне → помилка', () => {
    expect(vehicleUpdateSchema.parse({ engineVolume: '2.0' }).engineVolume).toBe(2);
    expect(vehicleUpdateSchema.parse({ currentMileage: '120000' }).currentMileage).toBe(120000);
    expect(vehicleUpdateSchema.safeParse({ currentMileage: '-5' }).success).toBe(false);
  });
});

describe('counterpartyFormSchema name-by-type (Bug #739 guard)', () => {
  it('SUPPLIER лише з firstName → помилка на companyName', () => {
    const r = counterpartyFormSchema.safeParse({ type: 'SUPPLIER', firstName: 'Іван' });
    expect(r.success).toBe(false);
  });
  it('CLIENT з firstName → OK; порожній email/legalForm → undefined (не помилка)', () => {
    const r = counterpartyFormSchema.parse({
      type: 'CLIENT',
      firstName: 'Іван',
      email: '',
      legalForm: '',
    });
    expect(r.email).toBeUndefined();
    expect(r.legalForm).toBeUndefined();
  });
  it('невалідний email → помилка', () => {
    expect(
      counterpartyFormSchema.safeParse({ type: 'CLIENT', firstName: 'Іван', email: 'zzz' }).success,
    ).toBe(false);
  });
  it('update-схема часткова: лише type=SUPPLIER проходить (merged-guard на беку)', () => {
    expect(counterpartyUpdateSchema.safeParse({ type: 'SUPPLIER' }).success).toBe(true);
  });
});
