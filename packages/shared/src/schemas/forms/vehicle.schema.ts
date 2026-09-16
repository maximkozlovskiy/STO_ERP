import { z } from 'zod';
import { optionalString, optionalUuid, emptyToUndefined } from '../validators';

/**
 * Спільна zod-схема автомобіля (Vehicle) — ЄДИНЕ джерело правди web ↔ api.
 *
 * Vehicle НЕ має Prisma-enum-ів: fuelType/transmission/drive/body — вільні рядки, а їхні
 * набори значень раніше жили як дубльовані фронт-константи у 2 сторінках. Виносимо сюди
 * (label-мапи) як єдине джерело для майбутнього спільного VehicleForm.
 */

export const FUEL_TYPE_OPTIONS = [
  { value: 'PETROL', label: 'Бензин' },
  { value: 'DIESEL', label: 'Дизель' },
  { value: 'GAS', label: 'Газ' },
  { value: 'HYBRID', label: 'Гібрид' },
  { value: 'ELECTRIC', label: 'Електро' },
] as const;

export const TRANSMISSION_OPTIONS = [
  { value: 'MANUAL', label: 'Механічна' },
  { value: 'AUTOMATIC', label: 'Автоматична' },
  { value: 'ROBOT', label: 'Робот' },
  { value: 'CVT', label: 'Варіатор' },
] as const;

export const DRIVE_OPTIONS = [
  { value: 'FWD', label: 'Передній' },
  { value: 'RWD', label: 'Задній' },
  { value: 'AWD', label: 'Повний' },
] as const;

export const BODY_OPTIONS = [
  { value: 'SEDAN', label: 'Седан' },
  { value: 'HATCHBACK', label: 'Хетчбек' },
  { value: 'WAGON', label: 'Універсал' },
  { value: 'SUV', label: 'Позашляховик' },
  { value: 'CROSSOVER', label: 'Кросовер' },
  { value: 'COUPE', label: 'Купе' },
  { value: 'MINIVAN', label: 'Мінівен' },
  { value: 'PICKUP', label: 'Пікап' },
  { value: 'VAN', label: 'Фургон' },
  { value: 'OTHER', label: 'Інше' },
] as const;

/** Резолвер label за value з option-масиву (для read-only відображення). Fallback — саме value. */
export function optionLabel(
  options: readonly { value: string; label: string }[],
  value: string | null | undefined,
): string {
  if (!value) return '';
  return options.find(o => o.value === value)?.label ?? value;
}

/** Опційне ціле з рядка форми: '' → undefined, '2015' → 2015. */
const optionalInt = () =>
  z.preprocess(emptyToUndefined, z.coerce.number().int('Має бути цілим числом').optional());
/** Опційне невідʼємне ціле (пробіг). */
const optionalNonNegInt = () =>
  z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0, "Не може бути від'ємним").optional(),
  );
/** Опційне невідʼємне число (обʼєм двигуна, Float). */
const optionalNonNegFloat = () =>
  z.preprocess(emptyToUndefined, z.coerce.number().min(0, "Не може бути від'ємним").optional());

// Базові поля Vehicle (без customerGarageId — його додає create-схема окремо: update його не має).
const vehicleBaseShape = {
  make: z.string().trim().min(1, 'Вкажіть марку').max(100, 'Занадто довго'),
  model: z.string().trim().min(1, 'Вкажіть модель').max(100, 'Занадто довго'),
  vin: optionalString(),
  licensePlate: optionalString(),
  year: optionalInt(),
  engineVolume: optionalNonNegFloat(),
  fuelType: optionalString(),
  currentMileage: optionalNonNegInt(),
  color: optionalString(),
  notes: optionalString(),
  transmissionType: optionalString(),
  driveType: optionalString(),
  bodyType: optionalString(),
  engineCode: optionalString(),
  insuranceExpiry: optionalString(),
  inspectionExpiry: optionalString(),
};

/**
 * Форма/створення авто. customerGarageId у ФОРМІ опційний (гараж резолвиться батьком:
 * з query-param або auto-create) — тому optionalUuid, а обовʼязковість гаража перевіряє
 * бек-схема vehicleCreateSchema. Форма валідує лише поля, які реально редагує користувач.
 */
export const vehicleFormSchema = z.object({
  customerGarageId: optionalUuid(),
  ...vehicleBaseShape,
});
export type VehicleFormValues = z.infer<typeof vehicleFormSchema>;
export type VehicleFormInput = z.input<typeof vehicleFormSchema>;

/** Бек-create: customerGarageId обовʼязковий UUID. */
export const vehicleCreateSchema = z.object({
  customerGarageId: z.string().uuid('Оберіть гараж клієнта'),
  ...vehicleBaseShape,
});
export type VehicleCreateValues = z.infer<typeof vehicleCreateSchema>;

/** Бек-update (PATCH): без customerGarageId (перенос гаража неможливий), усі поля опційні. */
export const vehicleUpdateSchema = z.object(vehicleBaseShape).partial();
export type VehicleUpdateValues = z.infer<typeof vehicleUpdateSchema>;
