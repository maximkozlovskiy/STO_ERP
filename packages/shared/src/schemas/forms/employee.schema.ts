import { z } from 'zod';
import { optionalString, emptyToUndefined } from '../validators';

/**
 * Плоске числове поле форми, чия обовʼязковість залежить від rateType.
 * Порожнє/нечислове → NaN, але поле НЕ падає на рівні `.number()` — фінітність
 * АКТИВНОГО поля (за rateType) перевіряє superRefine з локалізованим повідомленням.
 * Так неактивні (приховані) поля з порожнім значенням не блокують сабміт
 * не-локалізованим "Expected number, received nan". `z.number()` без .finite()
 * пропускає NaN → саме тому фінітність гейтимо у superRefine.
 */
const flatRateNumber = () =>
  z.preprocess(
    v => (v === '' || v === null || v === undefined ? NaN : Number(v)),
    // number АБО NaN: z.number() відкидає NaN → додаємо z.nan(), щоб порожнє
    // приховане поле не валило парсинг; активне поле гейтить superRefine.
    z.union([z.number(), z.nan()]),
  );

/**
 * Спільні zod-схеми співробітника (Employee) — ЄДИНЕ джерело правди web ↔ api.
 *
 * Два рівні:
 *  1. `rateSchemeSchema` — НЕСТ-форма схеми нарахування (discriminated union), яку валідує бек-payload
 *     і сервіс. Раніше жила лише в apps/api/employees.dto.ts — перенесено сюди для reuse.
 *  2. `employeeFormSchema` — ПЛОСКА форма (як web-стан): rateType + окремі числові поля, які модалка
 *     збирає у rateScheme. Крос-польові правила (діапазони, пароль при grantAccess) — у superRefine.
 */

// ─── Nested rateScheme (payload/бек) ─────────────────────────────────────────
export const rateSchemeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('percent_normo'),
    params: z.object({ percent: z.number().min(0).max(100) }),
  }),
  z.object({
    // Ставка за нормо-годину: accrued = ratePerHour * Σ normoHours завершених робіт.
    type: z.literal('per_normo_hour'),
    params: z.object({ ratePerHour: z.number().min(0) }),
  }),
  z.object({
    type: z.literal('fixed_plus_bonus'),
    params: z.object({ fixedMonthly: z.number().min(0), bonusPercent: z.number().min(0).max(100) }),
  }),
]);
export type RateScheme = z.infer<typeof rateSchemeSchema>;

export const RATE_TYPE_VALUES = ['percent_normo', 'per_normo_hour', 'fixed_plus_bonus'] as const;
export type RateType = (typeof RATE_TYPE_VALUES)[number];

// Дзеркалять Prisma-enum-и (shared не імпортує @prisma/client). Тримати синхронно зі schema.prisma.
export const USER_ROLE_VALUES = [
  'OWNER',
  'ADMIN',
  'RECEPTIONIST',
  'MECHANIC',
  'STOREKEEPER',
  'ACCOUNTANT',
  'XLSX_MANAGER',
  'CLIENT',
] as const;
export const EMPLOYEE_STATUS_VALUES = ['ACTIVE', 'ON_LEAVE', 'FIRED'] as const;

// ─── Плоска форма (web-стан) ─────────────────────────────────────────────────
export const employeeFormSchema = z
  .object({
    firstName: z
      .string()
      .trim()
      .min(1, 'v.employee.firstName.required')
      .max(100, 'v.employee.firstName.max'),
    lastName: z
      .string()
      .trim()
      .min(1, 'v.employee.lastName.required')
      .max(100, 'v.employee.lastName.max'),
    role: z.enum(USER_ROLE_VALUES, { error: 'v.employee.role.required' }),
    phone: optionalString(),
    email: optionalString(),
    status: z.preprocess(emptyToUndefined, z.enum(EMPLOYEE_STATUS_VALUES).optional()),
    dateOfHire: optionalString(),
    dateOfFire: optionalString(),
    // rateScheme — плоскі поля; числа з РЯДКІВ (web-стан) коерсимо у number; діапазони перевіряє
    // superRefine (нижче), бо залежать від rateType. z.preprocess(String→Number) типізує ВХІД як
    // рядок (на відміну від z.coerce.number, чий input=number) — сумісно з рядковим станом форми.
    rateType: z.enum(RATE_TYPE_VALUES),
    percent: flatRateNumber(),
    ratePerHour: flatRateNumber(),
    fixedMonthly: flatRateNumber(),
    bonusPercent: flatRateNumber(),
    // Доступ у систему (лише create).
    grantAccess: z.boolean().optional().default(false),
    loginEmail: optionalString(),
    password: optionalString(),
  })
  .superRefine((v, ctx) => {
    // Умовні правила rateScheme за rateType. Фінітність гейтимо ТІЛЬКИ для активного
    // поля (flatRateNumber пропускає NaN, щоб приховані неактивні поля не блокували
    // сабміт не-локалізованим повідомленням). NaN не проходить діапазонні порівняння
    // (`NaN <= 0` === false), тож без явного isFinite активне порожнє поле мовчки б
    // пройшло валідацію → тому перевіряємо isFinite першим.
    if (v.rateType === 'percent_normo') {
      if (!Number.isFinite(v.percent) || v.percent <= 0 || v.percent > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['percent'],
          message: 'v.employee.percent.range',
        });
      }
    }
    if (v.rateType === 'per_normo_hour') {
      if (!Number.isFinite(v.ratePerHour) || v.ratePerHour < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ratePerHour'],
          message: 'v.employee.ratePerHour.nonNeg',
        });
      }
    }
    if (v.rateType === 'fixed_plus_bonus') {
      if (!Number.isFinite(v.fixedMonthly) || v.fixedMonthly < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fixedMonthly'],
          message: 'v.employee.fixedMonthly.nonNeg',
        });
      }
      if (!Number.isFinite(v.bonusPercent) || v.bonusPercent < 0 || v.bonusPercent > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bonusPercent'],
          message: 'v.employee.bonusPercent.range',
        });
      }
    }
    // Доступ: при grantAccess loginEmail + пароль обовʼязкові.
    if (v.grantAccess) {
      if (!v.loginEmail || !v.loginEmail.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['loginEmail'],
          message: 'v.employee.loginEmail.required',
        });
      }
      if (!v.password) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['password'],
          message: 'v.employee.password.required',
        });
      } else if (v.password.length < 6) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['password'],
          message: 'v.employee.password.min',
        });
      }
    }
  });

export type EmployeeFormValues = z.infer<typeof employeeFormSchema>;
export type EmployeeFormInput = z.input<typeof employeeFormSchema>;

/**
 * Зібрати nested rateScheme з плоских (уже валідованих) значень форми.
 * Спільна функція — web (payload) і потенційно бек можуть переюзати.
 */
export function buildRateScheme(v: {
  rateType: RateType;
  percent: number;
  ratePerHour: number;
  fixedMonthly: number;
  bonusPercent: number;
}): RateScheme {
  switch (v.rateType) {
    case 'percent_normo':
      return { type: 'percent_normo', params: { percent: v.percent } };
    case 'per_normo_hour':
      return { type: 'per_normo_hour', params: { ratePerHour: v.ratePerHour } };
    case 'fixed_plus_bonus':
      return {
        type: 'fixed_plus_bonus',
        params: { fixedMonthly: v.fixedMonthly, bonusPercent: v.bonusPercent },
      };
  }
}

// ─── Бек-payload схеми (POST/PATCH /employees) ───────────────────────────────
// Валідують те, що реально шле модалка: базові поля + nested rateScheme + опційний доступ.
const employeeBaseFields = {
  firstName: z.string().trim().min(1, 'v.employee.firstName.required').max(100),
  lastName: z.string().trim().min(1, 'v.employee.lastName.required').max(100),
  role: z.enum(USER_ROLE_VALUES, { error: 'v.employee.role.required' }),
  phone: optionalString(),
  email: optionalString(),
  status: z.preprocess(emptyToUndefined, z.enum(EMPLOYEE_STATUS_VALUES).optional()),
  dateOfHire: optionalString(),
  dateOfFire: optionalString(),
  rateScheme: rateSchemeSchema,
};

export const employeeCreateSchema = z.object({
  ...employeeBaseFields,
  loginEmail: z.preprocess(
    emptyToUndefined,
    z.string().email('v.employee.loginEmail.invalid').max(254).optional(),
  ),
  password: z.preprocess(
    emptyToUndefined,
    z.string().min(6, 'v.employee.password.min').max(128).optional(),
  ),
});
export type EmployeeCreateValues = z.infer<typeof employeeCreateSchema>;

export const employeeUpdateSchema = z.object({ ...employeeBaseFields }).partial();
export type EmployeeUpdateValues = z.infer<typeof employeeUpdateSchema>;
