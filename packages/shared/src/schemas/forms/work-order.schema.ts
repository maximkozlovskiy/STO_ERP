import { z } from 'zod';
import {
  optionalString,
  optionalUuid,
  optionalDateString,
  optionalNonNegNumber,
  optionalMoneyNumber,
  numericString,
  moneyString,
} from '../validators';

/**
 * Спільні zod-схеми наряду (WorkOrder) — ЄДИНЕ джерело правди web ↔ api.
 *
 * АРХІТЕКТУРНА ОСОБЛИВІСТЬ (як Invoice): line-items (роботи) та parts (запчастини) НЕ у тілі
 * POST /work-orders — бек створює лише ШАПКУ, рядки/деталі додаються окремими endpoint-ами:
 *   · header:  workOrderHeaderSchema / workOrderUpdateSchema (POST/PATCH /work-orders)
 *   · line:    workOrderLineSchema / workOrderLineUpdateSchema (POST/PATCH /work-orders/:id/lines)
 *   · part:    workOrderPartSchema / workOrderPartUpdateSchema (POST/PATCH /work-orders/:id/parts)
 *   · form:    workOrderFormSchema — шапка + lines[] + parts[] (RHF+useFieldArray, multi-request submit).
 *
 * plannedAt/dueDate — ISO8601 (datetime); documentDate — YYYY-MM-DD. Усі через optionalDateString
 * (Date.parse приймає обидва формати) — дзеркалить @IsISO8601/@IsDateString.
 * Update-схеми: nullable-семантика (plannedAt/dueDate/liftId/plannedHours/actualHours: null очищає).
 */

export const WORK_ORDER_PRIORITY_VALUES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type WorkOrderPriorityValue = (typeof WORK_ORDER_PRIORITY_VALUES)[number];

export const REPAIR_CATEGORY_VALUES = [
  'MAINTENANCE',
  'CURRENT_REPAIR',
  'MAJOR_REPAIR',
  'BODY_REPAIR',
  'DIAGNOSTICS',
  'WARRANTY',
  'SEASONAL',
] as const;
export type RepairCategoryValue = (typeof REPAIR_CATEGORY_VALUES)[number];

// Опційний enum: '' → undefined, інакше валідне значення (дзеркалить @Transform(emptyToUndefined)+@IsEnum).
const optionalPriority = z.preprocess(
  v => (v === '' || v === null ? undefined : v),
  z.enum(WORK_ORDER_PRIORITY_VALUES).optional(),
);
const optionalRepairCategory = z.preprocess(
  v => (v === '' || v === null ? undefined : v),
  z.enum(REPAIR_CATEGORY_VALUES).optional(),
);

// Опційне ціле ≥0 (inMileage/outMileage) — дзеркалить @IsInt @Min(0).
const optionalNonNegInt = () =>
  z.preprocess(
    v => (v === '' || v === null || v === undefined ? undefined : v),
    z.coerce
      .number()
      .int('Значення має бути цілим')
      .min(0, "Значення не може бути від'ємним")
      .optional(),
  );

// ─── Шапка (POST /work-orders) ───────────────────────────────────────────────
export const workOrderHeaderSchema = z.object({
  branchId: z.string().uuid('Оберіть філію'),
  vehicleId: z.string().uuid('Оберіть авто'),
  counterpartyId: z.string().uuid('Оберіть контрагента'),
  contractId: optionalUuid(),
  description: optionalString(),
  inMileage: optionalNonNegInt(),
  priority: optionalPriority,
  repairCategory: optionalRepairCategory,
  plannedAt: optionalDateString(),
  dueDate: optionalDateString(),
  documentDate: optionalDateString(),
  currencyId: optionalUuid(),
  liftId: optionalUuid(),
  plannedHours: optionalNonNegNumber(),
});
export type WorkOrderHeaderValues = z.infer<typeof workOrderHeaderSchema>;
export type WorkOrderHeaderInput = z.input<typeof workOrderHeaderSchema>;

// Update — усі поля опційні (partial) + nullable для полів-очищення. class-validator DTO дозволяє
// null для plannedAt/dueDate/liftId/plannedHours/actualHours (null очищає). Тут дублюємо nullable.
// null → очистити (проходить першою гілкою union, ДО inner — інакше z.coerce.number()
// жадібно коерсить null→0). '' / undefined → undefined (не чіпати поле).
const nullable = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess(
    v => (v === '' || v === undefined ? undefined : v),
    z.union([z.null(), inner]).optional(),
  );

export const workOrderUpdateSchema = z.object({
  description: optionalString(),
  inMileage: optionalNonNegInt(),
  outMileage: optionalNonNegInt(),
  priority: optionalPriority,
  repairCategory: optionalRepairCategory,
  clientApproval: z.boolean().optional(),
  plannedAt: nullable(z.string().refine(v => !Number.isNaN(Date.parse(v)), 'Невірний формат дати')),
  dueDate: nullable(z.string().refine(v => !Number.isNaN(Date.parse(v)), 'Невірний формат дати')),
  documentDate: optionalDateString(),
  currencyId: optionalUuid(),
  liftId: nullable(z.string().uuid('Невірний UUID формат')),
  plannedHours: nullable(z.coerce.number().min(0, "Значення не може бути від'ємним")),
  actualHours: nullable(z.coerce.number().min(0, "Значення не може бути від'ємним")),
});
export type WorkOrderUpdateValues = z.infer<typeof workOrderUpdateSchema>;

// ─── Рядок-робота (POST /work-orders/:id/lines) ──────────────────────────────
export const workOrderLineSchema = z.object({
  workId: z.string().uuid('Оберіть роботу'),
  employeeId: z.string().uuid('Оберіть виконавця'),
  liftId: optionalUuid(),
  // normoHours опційна на беку (@Min(0.01)); price/actualHours опційні (@Min(0)).
  normoHours: z.preprocess(
    v => (v === '' || v === null || v === undefined ? undefined : v),
    z.coerce.number().min(0.01, 'Нормо-години повинні бути більшими за нуль').optional(),
  ),
  actualHours: optionalNonNegNumber(),
  price: optionalNonNegNumber(),
  notes: optionalString(),
});
export type WorkOrderLineValues = z.infer<typeof workOrderLineSchema>;
export type WorkOrderLineInput = z.input<typeof workOrderLineSchema>;

// Update line — усі поля опційні; actualHours nullable (null очищає, Bug #426).
export const workOrderLineUpdateSchema = z.object({
  workId: optionalUuid(),
  employeeId: optionalUuid(),
  liftId: optionalUuid(),
  normoHours: z.preprocess(
    v => (v === '' || v === null || v === undefined ? undefined : v),
    z.coerce.number().min(0.01, 'Нормо-години повинні бути більшими за нуль').optional(),
  ),
  actualHours: nullable(z.coerce.number().min(0, "Значення не може бути від'ємним")),
  price: optionalNonNegNumber(),
  notes: optionalString(),
});
export type WorkOrderLineUpdateValues = z.infer<typeof workOrderLineUpdateSchema>;

// ─── Деталь-запчастина (POST /work-orders/:id/parts) ─────────────────────────
export const workOrderPartSchema = z.object({
  goodId: z.string().uuid('Оберіть товар'),
  warehouseId: z.string().uuid('Оберіть склад'),
  quantity: numericString().pipe(z.number().min(0.001, 'Кількість повинна бути більшою за нуль')),
  price: optionalNonNegNumber(),
  unitOfMeasureId: optionalUuid(),
});
export type WorkOrderPartValues = z.infer<typeof workOrderPartSchema>;
export type WorkOrderPartInput = z.input<typeof workOrderPartSchema>;

export const workOrderPartUpdateSchema = z.object({
  goodId: optionalUuid(),
  warehouseId: optionalUuid(),
  quantity: z.preprocess(
    v => (v === '' || v === null || v === undefined ? undefined : v),
    z.coerce.number().min(0.001, 'Кількість повинна бути більшою за нуль').optional(),
  ),
  price: optionalNonNegNumber(),
  unitOfMeasureId: optionalUuid(),
});
export type WorkOrderPartUpdateValues = z.infer<typeof workOrderPartUpdateSchema>;

// ─── Форма web (шапка + lines[] + parts[]) ───────────────────────────────────
// Рядки форми несуть локальні display-поля (workName/employeeName/goodName…) поза схемою —
// widened у модалці. Тут — лише валідовані поля (submit шле їх окремими POST /lines, /parts).
// ⚠️ Form-схеми валідують СИРИЙ рядковий стан форми (inline-інпути WorksTable/PartsTable
// не конвертують кому) → числові поля кома-aware (`moneyString`/`optionalMoneyNumber`),
// дзеркалять `toNumberOrUndefined` у модалці. `numericString`/`z.coerce.number()` (Number('1,5')=NaN)
// заблокував би легітимний UA-ввід '1,5' на гейті safeParse(getValues()).
export const workOrderFormLineSchema = z.object({
  _key: z.string().optional(),
  id: z.string().optional(),
  workId: z.string().uuid('Оберіть роботу'),
  employeeId: z.string().uuid('Оберіть виконавця'),
  normoHours: z.preprocess(
    v =>
      v === '' || v === null || v === undefined
        ? undefined
        : typeof v === 'string'
          ? Number(v.replace(',', '.'))
          : v,
    z.number().min(0.01, 'Нормо-години повинні бути більшими за нуль').optional(),
  ),
  actualHours: optionalMoneyNumber(),
  price: optionalMoneyNumber(),
});

export const workOrderFormPartSchema = z.object({
  _key: z.string().optional(),
  id: z.string().optional(),
  goodId: z.string().uuid('Оберіть товар'),
  warehouseId: z.string().uuid('Оберіть склад'),
  quantity: moneyString().pipe(z.number().min(0.001, 'Кількість повинна бути більшою за нуль')),
  price: optionalMoneyNumber(),
  unitOfMeasureId: optionalUuid(),
});

export const workOrderFormSchema = z.object({
  branchId: z.string().uuid('Оберіть філію'),
  vehicleId: z.string().uuid('Оберіть авто'),
  counterpartyId: z.string().uuid('Оберіть контрагента'),
  contractId: optionalUuid(),
  currencyId: optionalUuid(),
  liftId: optionalUuid(),
  description: optionalString(),
  priority: optionalPriority,
  repairCategory: optionalRepairCategory,
  documentDate: optionalDateString(),
  // plannedStartAt/plannedEndAt — datetime-local у формі (конвертуються в ISO plannedAt/dueDate
  // при submit). Валідуємо як опційну дату (Date.parse приймає datetime-local).
  plannedStartAt: optionalDateString(),
  plannedEndAt: optionalDateString(),
  // Кома-aware: інпути «Планові/Фактичні години» — вільний рядок (UA '1,5').
  plannedHours: optionalMoneyNumber(),
  actualHours: optionalMoneyNumber(),
  lines: z.array(workOrderFormLineSchema).default([]),
  parts: z.array(workOrderFormPartSchema).default([]),
});
export type WorkOrderFormValues = z.infer<typeof workOrderFormSchema>;
export type WorkOrderFormInput = z.input<typeof workOrderFormSchema>;

// Бек create = шапка (header). Ре-експорт для контролера.
export const workOrderCreateSchema = workOrderHeaderSchema;
export type WorkOrderCreateValues = WorkOrderHeaderValues;
