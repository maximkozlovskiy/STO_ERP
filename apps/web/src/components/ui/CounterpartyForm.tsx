'use client';

import { COUNTERPARTY_TYPE_LABELS, hasCounterpartyName } from '@sto/shared';
import { counterpartyTypeLabel } from '@/i18n/enumLabel';
import type { UseFormRegister, FieldErrors, Control, UseFormWatch } from 'react-hook-form';
import { Controller } from 'react-hook-form';
import type { CounterpartyFormInput } from '@sto/shared';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { PhoneInput } from '@/components/ui/phone-input';
import type { Counterparty, CpType } from '@/hooks/api/useCounterparties';

export { hasCounterpartyName };

// Форми власності (@IsEnum LegalForm на беку). Єдине джерело для форми контрагента.
export const LEGAL_FORM_LABELS: Record<string, string> = {
  INDIVIDUAL: 'Фіз. особа',
  FOP: 'ФОП',
  TOV: 'ТОВ',
  AT: 'АТ',
  PP: 'ПП',
  OTHER: 'Інше',
};

/**
 * Єдине джерело правди набору полів контрагента (15 полів + type). Раніше редагування було
 * розколоте між CounterpartyEditModal (особисті/ЄДРПОУ) і DetailPage inline-edit (юр/банк) —
 * field-desync класу «каси». Компонент (RHF-native) використовується в ОБОХ місцях із тією самою
 * спільною zod-схемою (counterpartyFormSchema) → валідація й PATCH-тіло ідентичні звідусіль.
 */
export interface CounterpartyFormState {
  type: CpType;
  firstName: string;
  lastName: string;
  companyName: string;
  edrpou: string;
  vatPayer: boolean;
  phone: string;
  email: string;
  contactPerson: string;
  notes: string;
  legalForm: string;
  legalAddress: string;
  actualAddress: string;
  bankAccount: string;
  bankName: string;
  taxNumber: string;
}

export function emptyCounterpartyForm(type: CpType = 'CLIENT'): CounterpartyFormState {
  return {
    type,
    firstName: '',
    lastName: '',
    companyName: '',
    edrpou: '',
    vatPayer: false,
    phone: '',
    email: '',
    contactPerson: '',
    notes: '',
    legalForm: '',
    legalAddress: '',
    actualAddress: '',
    bankAccount: '',
    bankName: '',
    taxNumber: '',
  };
}

// Структурний вхід — приймає і hook-тип Counterparty, і локальні інтерфейси DetailPage (type: string).
type CounterpartyLike = Omit<Partial<Counterparty>, 'type'> & { type: string };

export function counterpartyToForm(cp: CounterpartyLike): CounterpartyFormState {
  return {
    type: cp.type as CpType,
    firstName: cp.firstName ?? '',
    lastName: cp.lastName ?? '',
    companyName: cp.companyName ?? '',
    edrpou: cp.edrpou ?? '',
    vatPayer: cp.vatPayer ?? false,
    phone: cp.phone ?? '',
    email: cp.email ?? '',
    contactPerson: cp.contactPerson ?? '',
    notes: cp.notes ?? '',
    legalForm: cp.legalForm ?? '',
    legalAddress: cp.legalAddress ?? '',
    actualAddress: cp.actualAddress ?? '',
    bankAccount: cp.bankAccount ?? '',
    bankName: cp.bankName ?? '',
    taxNumber: cp.taxNumber ?? '',
  };
}

interface Props {
  register: UseFormRegister<CounterpartyFormInput>;
  errors: FieldErrors<CounterpartyFormInput>;
  control: Control<CounterpartyFormInput>;
  watch: UseFormWatch<CounterpartyFormInput>;
}

/**
 * RHF-native форма контрагента (усі 15 полів + type). Керується батьком через
 * useForm(counterpartyFormSchema); тут лише register/Controller + per-field errors.
 * Секції: Основне / Юридичні / Банк. Ім'я/Прізвище приховані для SUPPLIER.
 */
export function CounterpartyForm({ register, errors, control, watch }: Props) {
  const type = watch('type');
  return (
    <div className="space-y-5">
      {/* ── Основне ─────────────────────────────────────────── */}
      <div className="space-y-3">
        <Select label="Тип" required {...register('type')} errorMessage={errors.type?.message}>
          {Object.keys(COUNTERPARTY_TYPE_LABELS).map(k => (
            <option key={k} value={k}>
              {counterpartyTypeLabel(k)}
            </option>
          ))}
        </Select>

        {type !== 'SUPPLIER' && (
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Ім'я"
              {...register('firstName')}
              errorMessage={errors.firstName?.message}
              placeholder="Іван"
            />
            <Input
              label="Прізвище"
              {...register('lastName')}
              errorMessage={errors.lastName?.message}
              placeholder="Коваль"
            />
          </div>
        )}

        <Input
          label="Назва компанії"
          required={type === 'SUPPLIER'}
          {...register('companyName')}
          errorMessage={errors.companyName?.message}
          placeholder="ТОВ «Авто»"
        />
        <Controller
          control={control}
          name="phone"
          render={({ field }) => (
            <PhoneInput
              label="Телефон"
              value={typeof field.value === 'string' ? field.value : ''}
              onChange={field.onChange}
            />
          )}
        />
        <Input
          label="Email"
          type="email"
          {...register('email')}
          errorMessage={errors.email?.message}
          placeholder="email@example.com"
        />
        <Input
          label="Контактна особа"
          {...register('contactPerson')}
          placeholder="Петро Іваненко"
        />
        <Input label="Нотатки" {...register('notes')} />
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            {...register('vatPayer')}
            className="h-4 w-4 rounded border-border accent-primary"
          />
          <span className="text-sm text-foreground">Платник ПДВ</span>
        </label>
      </div>

      {/* ── Юридичні реквізити ──────────────────────────────── */}
      <div className="space-y-3 border-t border-border pt-4">
        <p className="text-[13px] font-medium text-foreground">Юридичні реквізити</p>
        <Select
          label="Форма власності"
          {...register('legalForm')}
          errorMessage={errors.legalForm?.message}
        >
          <option value="">— Не вказано —</option>
          {Object.entries(LEGAL_FORM_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <div className="grid grid-cols-2 gap-3">
          <Input label="ЄДРПОУ" {...register('edrpou')} placeholder="12345678" />
          <Input label="ІПН / податковий №" {...register('taxNumber')} placeholder="3456789012" />
        </div>
        <Input
          label="Юридична адреса"
          {...register('legalAddress')}
          placeholder="вул. Хрещатик 1, Київ"
        />
        <Input
          label="Фактична адреса"
          {...register('actualAddress')}
          placeholder="вул. Хрещатик 1, Київ"
        />
      </div>

      {/* ── Банк ────────────────────────────────────────────── */}
      <div className="space-y-3 border-t border-border pt-4">
        <p className="text-[13px] font-medium text-foreground">Банківські реквізити</p>
        <div className="grid grid-cols-2 gap-3">
          <Input label="IBAN" {...register('bankAccount')} placeholder="UA12 3456 …" />
          <Input label="Банк" {...register('bankName')} placeholder="АТ КБ «ПриватБанк»" />
        </div>
      </div>
    </div>
  );
}
