import { z } from 'zod';
import { AUTOMATION_CHANNELS } from '../../constants/automation-rules';
import { optionalString } from '../validators';

/**
 * Спільна zod-схема контрагента (Counterparty) — ЄДИНЕ джерело правди web ↔ api.
 *
 * Крос-польове правило (name-by-type) — раніше дублювалося у 3 місцях (backend service
 * hasCounterpartyName, frontend CounterpartyForm.hasCounterpartyName, validateCounterpartyForm) —
 * тепер один superRefine. SUPPLIER → потрібна лише назва компанії; CLIENT/BOTH → компанія АБО імʼя.
 */

export const COUNTERPARTY_TYPE_VALUES = ['CLIENT', 'SUPPLIER', 'BOTH'] as const;
export type CounterpartyTypeValue = (typeof COUNTERPARTY_TYPE_VALUES)[number];

export const LEGAL_FORM_VALUES = ['INDIVIDUAL', 'FOP', 'TOV', 'AT', 'PP', 'OTHER'] as const;

/** Чи має форма коректну назву — TYPE-AWARE (дзеркалить backend hasCounterpartyName). */
export function hasCounterpartyName(f: {
  type: string;
  companyName?: string | null | undefined;
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
}): boolean {
  if (f.type === 'SUPPLIER') return !!f.companyName?.trim();
  return !!(f.companyName?.trim() || f.firstName?.trim() || f.lastName?.trim());
}

// Базові поля контрагента (15 + type). Рядкові опційні: '' → undefined.
const counterpartyBaseShape = {
  type: z.enum(COUNTERPARTY_TYPE_VALUES, {
    error: 'v.counterparty.type.required',
  }),
  firstName: optionalString(),
  lastName: optionalString(),
  companyName: optionalString(),
  edrpou: optionalString(),
  vatPayer: z.boolean().optional().default(false),
  phone: optionalString(),
  email: z.preprocess(
    v => (v === '' || v === null ? undefined : v),
    z.string().email('v.counterparty.email.invalid').optional(),
  ),
  contactPerson: optionalString(),
  notes: optionalString(),
  legalForm: z.preprocess(
    v => (v === '' || v === null ? undefined : v),
    z.enum(LEGAL_FORM_VALUES).optional(),
  ),
  legalAddress: optionalString(),
  actualAddress: optionalString(),
  bankAccount: optionalString(),
  bankName: optionalString(),
  taxNumber: optionalString(),
  // Згода на повідомлення (BR-AUT-012, 042) і бажаний канал (BR-AUT-011). Дату й автора згоди
  // ставить сервер. Bug #1000: поля були лише в Swagger-DTO, а тіло валідує ця схема — zod їх
  // викидав, PATCH відповідав 200 і нічого не зберігав. `null` у прапорцях — 400 з назвою поля.
  noServiceMessages: z.boolean().optional(),
  marketingConsent: z.boolean().optional(),
  // `null` — очистити бажаний канал. Перелік — усі канали повідомлень (= enum NotificationChannel).
  preferredChannel: z.enum(AUTOMATION_CHANNELS).nullable().optional(),
};

// Крос-польова перевірка name-by-type; помилка на companyName (форма підсвітить поле).
const nameByType = (
  v: {
    type: string;
    companyName?: string | undefined;
    firstName?: string | undefined;
    lastName?: string | undefined;
  },
  ctx: z.RefinementCtx,
) => {
  if (!hasCounterpartyName(v)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['companyName'],
      message: v.type === 'SUPPLIER' ? 'v.counterparty.name.supplier' : 'v.counterparty.name.any',
    });
  }
};

/** Форма/створення контрагента (type обовʼязковий). */
export const counterpartyFormSchema = z.object(counterpartyBaseShape).superRefine(nameByType);
export type CounterpartyFormValues = z.infer<typeof counterpartyFormSchema>;
export type CounterpartyFormInput = z.input<typeof counterpartyFormSchema>;

/**
 * Часткове оновлення (PATCH): усі поля опційні; name-by-type перевіряється на MERGED-стані у сервісі.
 * Bug #1001: `.partial()` у zod 4 НЕ прибирає `.default()` — `vatPayer` без default, інакше будь-який
 * частковий PATCH (тег, згода) мовчки скидав «Платник ПДВ» на false.
 */
export const counterpartyUpdateSchema = z
  .object({ ...counterpartyBaseShape, vatPayer: z.boolean().optional() })
  .partial();
export type CounterpartyUpdateValues = z.infer<typeof counterpartyUpdateSchema>;
