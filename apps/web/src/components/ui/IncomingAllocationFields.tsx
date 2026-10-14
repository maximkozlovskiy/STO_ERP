'use client';

import { useState, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { BANK_TX_IN_MATCH_TYPE_VALUES, type BankTxInMatchTypeValue } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { displayCounterpartyName } from '@/lib/utils';
import { fmtMoney, fmtBankCurrencySuffix } from '@/lib/format';
import type { Invoice } from '@/hooks/api/useInvoices';
import { Select } from '@/components/ui/select';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal } from '@/components/ui/search-picker-modal';
import { bankTxMatchTypeLabel } from '@/i18n/enumLabel';

/**
 * Поля рознесення ВХІДНОГО платежу (BR-BANK-008…010): контрагент, вид і — для «Оплати рахунку» —
 * рахунок цього контрагента. Спільні для вікна рознесення рядка (`MatchBankTransactionModal`) і
 * вікна «Новий банківський платіж» (BR-BANK-041). Компонент лише показує й змінює значення;
 * перевіряє і відправляє його вікно-власник.
 */
export interface IncomingAllocationValue {
  type: BankTxInMatchTypeValue;
  counterpartyId: string;
  counterpartyName: string;
  invoiceId: string;
  invoiceNumber: string;
  /** Залишок до сплати обраного рахунку з довідника; `null` — невідомо. */
  invoiceRemaining: number | null;
}

export const emptyIncomingAllocation = (
  type: BankTxInMatchTypeValue = 'PREPAYMENT',
  counterpartyId = '',
  counterpartyName = '',
): IncomingAllocationValue => ({
  type,
  counterpartyId,
  counterpartyName,
  invoiceId: '',
  invoiceNumber: '',
  invoiceRemaining: null,
});

const NO_INVOICE = { invoiceId: '', invoiceNumber: '', invoiceRemaining: null } as const;

interface CounterpartyRef {
  id: string;
  companyName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/** Рядок списку рахунків — зі згенерованого `InvoiceResponseDto`. */
type InvoiceRef = Pick<Invoice, 'id' | 'number' | 'amount' | 'paidAmount' | 'currencyCode'>;

/**
 * Рахунки, які оплата може закрити (як у `PaymentsService.create`): виставлений, частково
 * сплачений, прострочений. Відбір — на сервері (`GET /invoices?statuses=…&counterpartyId=…`).
 */
const PAYABLE_INVOICE_STATUSES = 'SENT,PARTIALLY_PAID,OVERDUE';
/** Скільки рахунків показує пікер за один пошук (як у пікера контрагентів). */
const INVOICE_PICK_LIMIT = 30;

interface InvoiceItem {
  id: string;
  primary: string;
  secondary: string;
  remaining: number | null;
}

type Picker = 'counterparty' | 'invoice' | null;

interface Props {
  value: IncomingAllocationValue;
  onChange: (next: IncomingAllocationValue) => void;
  /** Селект виду. У вікні створення вид обирає спільний селект «Рознести як». */
  showType?: boolean;
  counterpartyError?: string;
  invoiceError?: string;
  /**
   * Прапорець «відкрито пікер» для вікна-власника: Escape у пікері не має закривати саме вікно
   * (docs/GOTCHAS.md, 2026-10-12). Знімається ПІСЛЯ події, а не в ефекті.
   */
  pickerOpenRef?: MutableRefObject<boolean>;
}

const FIELD_ERROR = 'text-[12px] text-destructive leading-tight mt-1';

export function IncomingAllocationFields({
  value,
  onChange,
  showType = true,
  counterpartyError,
  invoiceError,
  pickerOpenRef,
}: Props) {
  const { t } = useTranslation('bankStatements');
  const [picker, setPicker] = useState<Picker>(null);

  const openPicker = (next: Exclude<Picker, null>) => {
    if (pickerOpenRef) pickerOpenRef.current = true;
    setPicker(next);
  };
  const closePicker = () => {
    setPicker(null);
    if (pickerOpenRef)
      setTimeout(() => {
        pickerOpenRef.current = false;
      }, 0);
  };

  return (
    <>
      <div>
        <EntityPickerField
          label={t('match.counterparty')}
          required
          display={value.counterpartyName}
          placeholder={t('match.counterpartyPlaceholder')}
          className="h-8 text-[13px]"
          onPick={() => openPicker('counterparty')}
          onClear={() => onChange({ ...value, counterpartyId: '', counterpartyName: '' })}
        />
        {counterpartyError && (
          <p role="alert" className={FIELD_ERROR}>
            {counterpartyError}
          </p>
        )}
      </div>

      {showType && (
        <Select
          label={t('match.type')}
          required
          value={value.type}
          onChange={e => {
            const next = e.target.value as BankTxInMatchTypeValue;
            onChange(
              next === 'INVOICE'
                ? { ...value, type: next }
                : { ...value, type: next, ...NO_INVOICE },
            );
          }}
          className="h-8 text-[13px]"
        >
          {BANK_TX_IN_MATCH_TYPE_VALUES.map(mt => (
            <option key={mt} value={mt}>
              {bankTxMatchTypeLabel(mt)}
            </option>
          ))}
        </Select>
      )}

      {/* Рахунок (лише для «Оплати рахунку») — рахунки обраного контрагента */}
      {value.type === 'INVOICE' && (
        <div>
          <EntityPickerField
            label={t('match.invoice')}
            required
            display={value.invoiceNumber}
            placeholder={t('match.invoicePlaceholder')}
            className="h-8 text-[13px]"
            disabled={!value.counterpartyId}
            onPick={() => openPicker('invoice')}
            onClear={() => onChange({ ...value, ...NO_INVOICE })}
          />
          {invoiceError && (
            <p role="alert" className={FIELD_ERROR}>
              {invoiceError}
            </p>
          )}
        </div>
      )}

      <SearchPickerModal
        open={picker === 'counterparty'}
        onClose={closePicker}
        selectedId={value.counterpartyId || null}
        onSelect={(item: { id: string; primary: string }) => {
          // Зміна контрагента скидає рахунок: рахунок належить контрагенту.
          onChange({
            ...value,
            counterpartyId: item.id,
            counterpartyName: item.primary,
            ...NO_INVOICE,
          });
          closePicker();
        }}
        title={t('match.pickCounterparty')}
        fetchItems={q =>
          apiFetch<{ items: CounterpartyRef[] }>(
            `/counterparties?q=${encodeURIComponent(q)}&limit=30`,
          ).then(d => d.items.map(c => ({ id: c.id, primary: displayCounterpartyName(c) })))
        }
      />

      <SearchPickerModal<InvoiceItem>
        open={picker === 'invoice'}
        onClose={closePicker}
        selectedId={value.invoiceId || null}
        onSelect={item => {
          onChange({
            ...value,
            invoiceId: item.id,
            invoiceNumber: item.primary,
            invoiceRemaining: item.remaining,
          });
          closePicker();
        }}
        title={t('match.pickInvoice')}
        fetchItems={q =>
          apiFetch<{ items: InvoiceRef[] }>(
            `/invoices?${new URLSearchParams({
              q,
              counterpartyId: value.counterpartyId,
              statuses: PAYABLE_INVOICE_STATUSES,
              limit: String(INVOICE_PICK_LIMIT),
            }).toString()}`,
          ).then(d =>
            d.items.map(inv => ({
              id: inv.id,
              primary: inv.number,
              // Сума у валюті самого рахунку (Bug #864: «₴» стояв біля будь-якої).
              secondary: `${fmtMoney(inv.amount)} ${fmtBankCurrencySuffix(inv.currencyCode)}`,
              remaining: inv.paidAmount == null ? null : Math.max(0, inv.amount - inv.paidAmount),
            })),
          )
        }
      />
    </>
  );
}
