import { z } from 'zod';

export const PHONE_UA_REGEX = /^\+380\d{9}$/;
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const IBAN_UA_REGEX = /^UA\d{27}$/;
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const phoneUaSchema = z.string().regex(PHONE_UA_REGEX, 'v.phone');
export const emailSchema = z.string().email('v.email');
export const ibanUaSchema = z.string().regex(IBAN_UA_REGEX, 'v.iban');
/** Field-level UUID validator (regex-based). See also uuidSchema in schemas.ts for Zod .uuid(). */
export const uuidFieldSchema = z.string().regex(UUID_REGEX, 'v.uuid');
export const positiveNumberSchema = z.number().positive('v.positive');
export const nonNegativeNumberSchema = z.number().min(0, 'v.nonNeg');

/**
 * Форма-хелпери для спільних zod-схем (web ↔ api).
 *
 * Web-поля майже завжди рядки (навіть числа/дати): порожній рядок означає «не задано».
 * Ці хелпери дзеркалять беківський `@Transform(emptyToUndefined)` + `@Type(() => Number)`,
 * щоб ОДНА схема валідувала і рядковий payload з форми, і вже-типізований JSON.
 */

/** Порожній рядок / null → undefined (перед .optional()). Дзеркалить emptyToUndefined на беку. */
export const emptyToUndefined = (v: unknown): unknown => (v === '' || v === null ? undefined : v);

/** Опційний рядок: '' → undefined, trim не робимо (робить бек/схема за потреби). */
export const optionalString = () => z.preprocess(emptyToUndefined, z.string().optional());

/** Опційний UUID: '' → undefined, інакше валідний UUID. */
export const optionalUuid = () => z.preprocess(emptyToUndefined, uuidFieldSchema.optional());

/**
 * Опційна дата-рядок (ISO/`YYYY-MM-DD`): '' → undefined, інакше валідована.
 * Дзеркалить беківський `@IsDateString()` — без цього довільний рядок (напр. 'not-a-date')
 * проходить схему і летить у Prisma `DateTime?` → PrismaClientValidationError (500 замість
 * локалізованого 400). `z.coerce.date()` парсить і `2025-01-01`, і повний ISO; невалідне → issue.
 */
export const optionalDateString = () =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .refine(v => !Number.isNaN(Date.parse(v)), { message: 'v.dateFormat' })
      .optional(),
  );

/**
 * Опційне невід'ємне число з коерцією з рядка: '' → undefined, '350' → 350.
 * `z.coerce.number()` перетворює рядок; порожнє відсікаємо ДО коерції (інакше '' → 0).
 */
export const optionalNonNegNumber = (cap?: NumberCap) =>
  z.preprocess(emptyToUndefined, withCap(z.coerce.number().min(0, 'v.nonNeg'), cap).optional());

/**
 * Обовʼязкове число з рядка форми: `z.input` приймає рядок web-стану, `z.output` = number.
 * На відміну від `z.coerce.number()` (input=number), сумісне з рядковим станом react-hook-form.
 * Порожнє/нечислове → NaN → падає на .number() (діапазони уточнює superRefine у доменній схемі).
 */
export const numericString = () =>
  z.preprocess(
    v => (v === '' || v === null || v === undefined ? NaN : Number(v)),
    // Повідомлення ОБОВ'ЯЗКОВЕ: без нього Zod віддає англійський дефолт
    // («Invalid input: expected number, received NaN») просто у відповідь API,
    // упереміш з українськими — видно на живому 400 (Крок 4 аудиту).
    z.number('v.invalidNumber'),
  );

/**
 * Найбільша сума, яку вміщує колонка `Decimal(12,2)`. Більша доходила до бази й поверталась
 * безіменною 500 (`numeric field overflow`) замість 400 із назвою поля (Bug #846).
 */
export const MONEY_AMOUNT_MAX = 9_999_999_999.99;

/**
 * Стеля кількості, нормогодин і мінімального залишку. Колонки `Float` самі не переповнюються, але
 * кількість × ціна лягає в `Decimal(12,2)`-суму рядка, а мільйон одиниць чи годин в одному рядку
 * документа СТО — завжди помилка вводу. Повідомлення `v.qtyMax` називає це число — міняти разом.
 */
export const QTY_MAX = 1_000_000;

/** Стеля числового поля разом із ключем повідомлення — передається в хелпери нижче. */
export interface NumberCap {
  value: number;
  message: string;
}
/** Грошове поле: місткість `Decimal(12,2)`. */
export const MONEY_CAP: NumberCap = { value: MONEY_AMOUNT_MAX, message: 'v.amountMax' };
/** Кількість, години, мінімальний залишок. */
export const QTY_CAP: NumberCap = { value: QTY_MAX, message: 'v.qtyMax' };

/** Додає стелю до числової схеми; без `cap` схема не змінюється. */
export function withCap<T extends { max(value: number, message?: string): T }>(
  schema: T,
  cap?: NumberCap,
): T {
  return cap ? schema.max(cap.value, cap.message) : schema;
}

/**
 * Грошова сума з рядка форми з підтримкою UA-локалі (кома як десятковий роздільник).
 * Дзеркалить фронтове `amount.replace(',', '.')` — '1,5' → 1.5. `z.input` — рядок, `z.output` = number.
 * Порожнє/нечислове → NaN → падає на .number(); діапазон (min 0.01) додає доменна схема через .pipe().
 */
export const moneyString = () =>
  z.preprocess(v => {
    if (v === '' || v === null || v === undefined) return NaN;
    if (typeof v === 'string') return Number(v.replace(',', '.'));
    return Number(v);
  }, z.number('v.invalidNumber'));

/**
 * Опційне невід'ємне число з UA-комою: '' / null → undefined, '1,5' → 1.5.
 * Як `optionalNonNegNumber`, але кома-aware (дзеркалить фронтове `toNumberOrUndefined`,
 * що робить `.replace(',', '.')`). Потрібне для form-схем де інпут — вільний рядок і
 * користувач може ввести UA-десятковий роздільник (наряди/рахунки: normoHours/price/hours).
 * `z.coerce.number()` НЕ кома-aware (Number('1,5')=NaN) → без цього легітимний '1,5' блокує submit.
 */
export const optionalMoneyNumber = (cap?: NumberCap) =>
  z.preprocess(
    v => {
      if (v === '' || v === null || v === undefined) return undefined;
      if (typeof v === 'string') return Number(v.replace(',', '.'));
      return v;
    },
    withCap(z.number().min(0, 'v.nonNeg'), cap).optional(),
  );
