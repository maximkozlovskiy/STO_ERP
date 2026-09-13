'use client';

import { COUNTERPARTY_TYPE_LABELS } from '@sto/shared';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { PhoneInput } from '@/components/ui/phone-input';
import type { Counterparty, CpType } from '@/hooks/api/useCounterparties';

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
 * field-desync класу «каси». Цей контрольований компонент використовується в ОБОХ місцях, тож
 * PATCH-тіло (formToPatch) ідентичне звідусіль.
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

/** PATCH/POST-тіло з форми. Порожні рядки → undefined (не затираємо; конвенція обох старих форм). */
export function formToPatch(f: CounterpartyFormState): Record<string, unknown> {
  const u = (v: string) => (v.trim() === '' ? undefined : v.trim());
  return {
    type: f.type,
    firstName: u(f.firstName),
    lastName: u(f.lastName),
    companyName: u(f.companyName),
    edrpou: u(f.edrpou),
    vatPayer: f.vatPayer,
    phone: u(f.phone),
    email: u(f.email),
    contactPerson: u(f.contactPerson),
    notes: u(f.notes),
    legalForm: u(f.legalForm),
    legalAddress: u(f.legalAddress),
    actualAddress: u(f.actualAddress),
    bankAccount: u(f.bankAccount),
    bankName: u(f.bankName),
    taxNumber: u(f.taxNumber),
  };
}

/** Валідація: має бути назва компанії АБО ім'я/прізвище (дзеркалить backend hasCounterpartyName). */
export function validateCounterpartyForm(f: CounterpartyFormState): string | null {
  const hasName = f.companyName.trim() !== '' || `${f.firstName}${f.lastName}`.trim() !== '';
  if (!hasName) return 'Вкажіть назву компанії або ім’я/прізвище контрагента';
  return null;
}

interface Props {
  value: CounterpartyFormState;
  onChange: (patch: Partial<CounterpartyFormState>) => void;
  /** create: type-Select активний завжди; edit: теж активний (type тепер редагований). */
  mode?: 'create' | 'edit';
}

/** Контрольована форма контрагента (усі 15 полів + type). Секції: Основне / Юридичні / Банк. */
export function CounterpartyForm({ value: f, onChange }: Props) {
  return (
    <div className="space-y-5">
      {/* ── Основне ─────────────────────────────────────────── */}
      <div className="space-y-3">
        <Select
          label="Тип"
          required
          value={f.type}
          onChange={e => onChange({ type: e.target.value as CpType })}
        >
          {Object.entries(COUNTERPARTY_TYPE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>

        {f.type !== 'SUPPLIER' && (
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Ім'я"
              value={f.firstName}
              onChange={e => onChange({ firstName: e.target.value })}
              placeholder="Іван"
            />
            <Input
              label="Прізвище"
              value={f.lastName}
              onChange={e => onChange({ lastName: e.target.value })}
              placeholder="Коваль"
            />
          </div>
        )}

        <Input
          label="Назва компанії"
          required={f.type === 'SUPPLIER'}
          value={f.companyName}
          onChange={e => onChange({ companyName: e.target.value })}
          placeholder="ТОВ «Авто»"
        />
        <PhoneInput
          label="Телефон"
          value={f.phone}
          onChange={e => onChange({ phone: e.target.value })}
        />
        <Input
          label="Email"
          type="email"
          value={f.email}
          onChange={e => onChange({ email: e.target.value })}
          placeholder="email@example.com"
        />
        <Input
          label="Контактна особа"
          value={f.contactPerson}
          onChange={e => onChange({ contactPerson: e.target.value })}
          placeholder="Петро Іваненко"
        />
        <Input
          label="Нотатки"
          value={f.notes}
          onChange={e => onChange({ notes: e.target.value })}
        />
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={f.vatPayer}
            onChange={e => onChange({ vatPayer: e.target.checked })}
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
          value={f.legalForm}
          onChange={e => onChange({ legalForm: e.target.value })}
        >
          <option value="">— Не вказано —</option>
          {Object.entries(LEGAL_FORM_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="ЄДРПОУ"
            value={f.edrpou}
            onChange={e => onChange({ edrpou: e.target.value })}
            placeholder="12345678"
          />
          <Input
            label="ІПН / податковий №"
            value={f.taxNumber}
            onChange={e => onChange({ taxNumber: e.target.value })}
            placeholder="3456789012"
          />
        </div>
        <Input
          label="Юридична адреса"
          value={f.legalAddress}
          onChange={e => onChange({ legalAddress: e.target.value })}
          placeholder="вул. Хрещатик 1, Київ"
        />
        <Input
          label="Фактична адреса"
          value={f.actualAddress}
          onChange={e => onChange({ actualAddress: e.target.value })}
          placeholder="вул. Хрещатик 1, Київ"
        />
      </div>

      {/* ── Банк ────────────────────────────────────────────── */}
      <div className="space-y-3 border-t border-border pt-4">
        <p className="text-[13px] font-medium text-foreground">Банківські реквізити</p>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="IBAN"
            value={f.bankAccount}
            onChange={e => onChange({ bankAccount: e.target.value })}
            placeholder="UA12 3456 …"
          />
          <Input
            label="Банк"
            value={f.bankName}
            onChange={e => onChange({ bankName: e.target.value })}
            placeholder="АТ КБ «ПриватБанк»"
          />
        </div>
      </div>
    </div>
  );
}
