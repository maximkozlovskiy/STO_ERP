'use client';

import { COUNTERPARTY_TYPE_LABELS, hasCounterpartyName } from '@sto/shared';
import { counterpartyTypeLabel } from '@/i18n/enumLabel';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import type { UseFormRegister, FieldErrors, Control, UseFormWatch } from 'react-hook-form';
import { Controller } from 'react-hook-form';
import type { CounterpartyFormInput } from '@sto/shared';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { PhoneInput } from '@/components/ui/phone-input';
import { cn } from '@/lib/utils';
import type { Counterparty, CpType } from '@/hooks/api/useCounterparties';

export { hasCounterpartyName };

// Форми власності (@IsEnum LegalForm на беку). Єдине джерело для форми контрагента;
// мітки — counterparties:card.legalForm.<CODE> (ті самі, що на сторінці контрагента).
export const LEGAL_FORM_CODES = ['INDIVIDUAL', 'FOP', 'TOV', 'AT', 'PP', 'OTHER'] as const;

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
  /**
   * Вміст праворуч від поля «Тип», у тому самому рядку (модалка кладе сюди статуси-мітки).
   * Без нього «Тип» займає всю ширину, як раніше.
   */
  typeAside?: ReactNode;
}

interface SectionProps {
  title: string;
  /** Є помилка валідації в секції — вона розкривається сама, інакше помилки не видно. */
  hasError: boolean;
  /** У секції є заповнені поля — згорнутий заголовок це показує, щоб дані не «зникали». */
  filled: boolean;
  children: ReactNode;
}

/**
 * Згортувана секція форми. Згорнута за замовчуванням (рішення власника 2026-10-12): юридичні й
 * банківські реквізити потрібні рідко, а форма без них уміщається на екран.
 *
 * Вміст НЕ розмонтовується, а ховається атрибутом `hidden`: поля лишаються зареєстрованими в
 * react-hook-form, тож значення й валідація працюють і для згорнутої секції.
 */
function FormSection({ title, hasError, filled, children }: SectionProps) {
  const { t } = useTranslation('counterparties');
  const [opened, setOpened] = useState(false);
  // Помилка розкриває секцію НАЗАВЖДИ (до ручного згортання), а не лише поки вона є: інакше
  // секція згорталась би під курсором у ту мить, коли користувач виправив поле (після невдалого
  // сабміту react-hook-form перевіряє на кожну зміну) — фокус лишився б у прихованому полі.
  if (hasError && !opened) setOpened(true);
  const open = opened;
  const contentId = useId();
  return (
    <div className="border-t border-border pt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpened(v => !v)}
        className="flex w-full items-center gap-1.5 rounded-md py-1 text-left text-[13px] font-medium text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <ChevronRight
          className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-90')}
          aria-hidden
        />
        <span>{title}</span>
        {!open && filled && (
          <span className="ml-2 text-[12px] font-normal text-muted-foreground">
            {t('form.filled')}
          </span>
        )}
      </button>
      <div id={contentId} hidden={!open} className="space-y-3 pt-3">
        {children}
      </div>
    </div>
  );
}

const hasValue = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

/**
 * RHF-native форма контрагента (усі 15 полів + type). Керується батьком через
 * useForm(counterpartyFormSchema); тут лише register/Controller + per-field errors.
 * Секції: Основне / Юридичні / Банк. Ім'я/Прізвище приховані для SUPPLIER.
 */
export function CounterpartyForm({ register, errors, control, watch, typeAside }: Props) {
  const { t } = useTranslation('counterparties');
  const type = watch('type');
  const legalFilled = watch([
    'legalForm',
    'edrpou',
    'taxNumber',
    'legalAddress',
    'actualAddress',
  ]).some(hasValue);
  const bankFilled = watch(['bankAccount', 'bankName']).some(hasValue);
  const typeSelect = (
    <Select
      label={t('columns.type')}
      required
      {...register('type')}
      errorMessage={errors.type?.message}
    >
      {Object.keys(COUNTERPARTY_TYPE_LABELS).map(k => (
        <option key={k} value={k}>
          {counterpartyTypeLabel(k)}
        </option>
      ))}
    </Select>
  );
  return (
    <div className="space-y-5">
      {/* ── Основне ─────────────────────────────────────────── */}
      <div className="space-y-3">
        {typeAside ? (
          <div className="grid grid-cols-2 items-start gap-3">
            {typeSelect}
            <div className="min-w-0">{typeAside}</div>
          </div>
        ) : (
          typeSelect
        )}

        {type !== 'SUPPLIER' && (
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t('form.firstName')}
              {...register('firstName')}
              errorMessage={errors.firstName?.message}
              placeholder={t('form.firstNamePlaceholder')}
            />
            <Input
              label={t('form.lastName')}
              {...register('lastName')}
              errorMessage={errors.lastName?.message}
              placeholder={t('form.lastNamePlaceholder')}
            />
          </div>
        )}

        <Input
          label={t('form.companyName')}
          required={type === 'SUPPLIER'}
          {...register('companyName')}
          errorMessage={errors.companyName?.message}
          placeholder={t('form.companyNamePlaceholder')}
        />
        <Controller
          control={control}
          name="phone"
          render={({ field }) => (
            <PhoneInput
              label={t('columns.phone')}
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
          label={t('card.info.contactPerson')}
          {...register('contactPerson')}
          placeholder={t('form.contactPersonPlaceholder')}
        />
        <Input label={t('card.info.notes')} {...register('notes')} />
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            {...register('vatPayer')}
            className="h-4 w-4 rounded border-border accent-primary"
          />
          <span className="text-sm text-foreground">{t('card.vatPayer')}</span>
        </label>
      </div>

      {/* ── Юридичні реквізити ──────────────────────────────── */}
      <FormSection
        title={t('form.legalSection')}
        hasError={
          !!(
            errors.legalForm ||
            errors.edrpou ||
            errors.taxNumber ||
            errors.legalAddress ||
            errors.actualAddress
          )
        }
        filled={legalFilled}
      >
        <Select
          label={t('card.info.legalForm')}
          {...register('legalForm')}
          errorMessage={errors.legalForm?.message}
        >
          <option value="">{t('form.notSpecified')}</option>
          {LEGAL_FORM_CODES.map(k => (
            <option key={k} value={k}>
              {t(`card.legalForm.${k}`)}
            </option>
          ))}
        </Select>
        <div className="grid grid-cols-2 gap-3">
          <Input label={t('columns.edrpou')} {...register('edrpou')} placeholder="12345678" />
          <Input label={t('form.taxNumber')} {...register('taxNumber')} placeholder="3456789012" />
        </div>
        <Input
          label={t('form.legalAddress')}
          {...register('legalAddress')}
          placeholder={t('form.addressPlaceholder')}
        />
        <Input
          label={t('form.actualAddress')}
          {...register('actualAddress')}
          placeholder={t('form.addressPlaceholder')}
        />
      </FormSection>

      {/* ── Банк ────────────────────────────────────────────── */}
      <FormSection
        title={t('form.bankSection')}
        hasError={!!(errors.bankAccount || errors.bankName)}
        filled={bankFilled}
      >
        <div className="grid grid-cols-2 gap-3">
          <Input label="IBAN" {...register('bankAccount')} placeholder="UA12 3456 …" />
          <Input
            label={t('card.info.bank')}
            {...register('bankName')}
            placeholder={t('form.bankNamePlaceholder')}
          />
        </div>
      </FormSection>
    </div>
  );
}
