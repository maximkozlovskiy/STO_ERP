import { z } from 'zod';
import { optionalString, optionalUuid, optionalDateString, emptyToUndefined } from '../validators';

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

/**
 * Опційний рік випуску: '' → undefined, '2015' → 2015. Діапазон 1900..поточний+1
 * (дзеркалить прибраний HTML `min=1900 max=2100` старих форм — без нього рік міг бути
 * будь-яким цілим: '50', '-100', '999999'). Верхня межа — наступний модельний рік.
 */
const optionalYear = () =>
  z.preprocess(
    emptyToUndefined,
    z.coerce
      .number()
      .int('v.vehicle.year.int')
      .min(1900, 'v.vehicle.year.min')
      .max(new Date().getFullYear() + 1, 'v.vehicle.year.max')
      .optional(),
  );
/** Опційне невідʼємне ціле (пробіг). */
const optionalNonNegInt = () =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(0, 'v.vehicle.nonNegInt').optional());
/** Опційне невідʼємне число (обʼєм двигуна, Float). */
const optionalNonNegFloat = () =>
  z.preprocess(emptyToUndefined, z.coerce.number().min(0, 'v.vehicle.nonNegFloat').optional());

// Базові поля Vehicle (без customerGarageId — його додає create-схема окремо: update його не має).
// Марка й модель — лише з довідників (BR-VEH-008): клієнт передає ідентифікатори, назву
// (`make` / `model`) пише сервіс. Порожній вибір ('') не проходить uuid → «Вкажіть марку».
const vehicleBaseShape = {
  makeId: z.string().uuid('v.vehicle.make.required'),
  modelId: z.string().uuid('v.vehicle.model.required'),
  vin: optionalString(),
  licensePlate: optionalString(),
  year: optionalYear(),
  engineVolume: optionalNonNegFloat(),
  fuelType: optionalString(),
  currentMileage: optionalNonNegInt(),
  color: optionalString(),
  notes: optionalString(),
  transmissionType: optionalString(),
  driveType: optionalString(),
  bodyType: optionalString(),
  engineCode: optionalString(),
  insuranceExpiry: optionalDateString(),
  inspectionExpiry: optionalDateString(),
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
  customerGarageId: z.string().uuid('v.vehicle.customerGarage.required'),
  ...vehicleBaseShape,
});
export type VehicleCreateValues = z.infer<typeof vehicleCreateSchema>;

/**
 * Бек-update (PATCH): без customerGarageId (перенос гаража неможливий), усі поля опційні. Нова
 * марка — лише разом із моделлю: стара модель їй не належить (BR-VEH-008).
 */
export const vehicleUpdateSchema = z
  .object(vehicleBaseShape)
  .partial()
  .refine(v => v.makeId === undefined || v.modelId !== undefined, {
    message: 'v.vehicle.model.required',
    path: ['modelId'],
  });
export type VehicleUpdateValues = z.infer<typeof vehicleUpdateSchema>;

/**
 * Назва марки чи моделі в довіднику (BR-VEH-006/007): крайні пробіли прибрано, внутрішні
 * стиснуто до одного. Унікальність — за `vehicleNameKey` (без урахування регістру).
 */
const vehicleDirectoryName = (required: string, max: string) =>
  z
    .string()
    .transform(s => s.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1, required).max(100, max));

export const vehicleMakeSchema = z.object({
  name: vehicleDirectoryName('v.vehicle.make.required', 'v.vehicle.make.max'),
});
export type VehicleMakeValues = z.infer<typeof vehicleMakeSchema>;

export const vehicleModelSchema = z.object({
  name: vehicleDirectoryName('v.vehicle.model.required', 'v.vehicle.model.max'),
});
export type VehicleModelValues = z.infer<typeof vehicleModelSchema>;

/** Злиття марки чи моделі в іншу (BR-VEH-010): авто й моделі переходять до `targetId`. */
export const vehicleDirectoryMergeSchema = z.object({
  targetId: z.string().uuid(),
});
export type VehicleDirectoryMergeValues = z.infer<typeof vehicleDirectoryMergeSchema>;

/**
 * Ключ унікальності назви марки чи моделі — той самий, що в міграції
 * `20261023180000_vehicle_makes_and_models`: `lower(regexp_replace(btrim(x), '\s+', ' ', 'g'))`.
 */
export function vehicleNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Довідник марок для форм і вкладки (GET /vehicle-makes). */
export interface VehicleMakeDto {
  id: string;
  name: string;
  /** Живі авто з цією маркою — видалити марку з ними не можна (BR-VEH-009). */
  vehicleCount: number;
  modelCount: number;
  deletedAt: string | null;
}

/** Моделі марки (GET /vehicle-makes/:id/models). */
export interface VehicleModelDto {
  id: string;
  makeId: string;
  name: string;
  vehicleCount: number;
  deletedAt: string | null;
}
