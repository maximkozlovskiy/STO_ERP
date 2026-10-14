'use client';

import { useEffect, useMemo, useState, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Controller, type UseFormReturn } from 'react-hook-form';
import type {
  BankTransactionReconcileFormValues,
  BankTransactionReconcilePayload,
  BankTxOutMatchTypeValue,
} from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { cn, displayCounterpartyName } from '@/lib/utils';
import { fmtDate } from '@/lib/format';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal } from '@/components/ui/search-picker-modal';
import {
  useBankAccountOptions,
  type ReconcileTransactionInput,
  type SupplierPaymentCandidate,
} from '@/hooks/api/useBankStatements';
import { cashKeys, type CashRegister } from '@/hooks/api/useCash';
import { useExpenseCategories, flattenActiveByType } from '@/hooks/api/useExpenseCategories';
import { payrollKeys, type PaginatedPayrollPeriods } from '@/hooks/api/usePayroll';
import { useBranches } from '@/hooks/api/useInfrastructure';

/**
 * Поля рознесення ВИХІДНОГО платежу за видом (BR-BANK-025…034) — і переказу для вхідного.
 * Спільні для вікна рознесення рядка (`MatchOutgoingBankTransactionModal`) і вікна «Новий
 * банківський платіж» (BR-BANK-041). Працюють від рахунку й валюти платежу, а не від
 * збереженого рядка: при внесенні рядка ще немає. Селект виду, перевірку й відправку тримає
 * вікно-власник; тут — поля обраного виду та їхні довідники.
 */

export type OutgoingAllocationForm = UseFormReturn<
  BankTransactionReconcileFormValues,
  unknown,
  BankTransactionReconcilePayload
>;

export type SupplierMode = 'existing' | 'new';

/** Підписи обраних посилань — для полів і тексту підтвердження у вікні-власнику. */
export interface OutgoingAllocationLabels {
  counterpartyName: string;
  purchaseOrderNumber: string;
  employeeName: string;
  cashRegisterName: string;
}

export const EMPTY_OUTGOING_LABELS: OutgoingAllocationLabels = {
  counterpartyName: '',
  purchaseOrderNumber: '',
  employeeName: '',
  cashRegisterName: '',
};

/** Поля-посилання форми: зміна виду очищує всі. */
export const OUTGOING_LINK_FIELDS = [
  'counterpartyId',
  'supplierPaymentId',
  'purchaseOrderId',
  'expenseCategoryId',
  'payrollPeriodId',
  'employeeId',
  'transferBankAccountId',
  'cashRegisterId',
] as const;

export const emptyOutgoingAllocation = (
  type: BankTxOutMatchTypeValue,
): BankTransactionReconcileFormValues => ({
  type,
  counterpartyId: '',
  supplierPaymentId: '',
  purchaseOrderId: '',
  expenseCategoryId: '',
  payrollPeriodId: '',
  employeeId: '',
  transferBankAccountId: '',
  cashRegisterId: '',
});

/** Лише поля, що стосуються обраного виду: зайве посилання бекенд відхилить або, гірше, прийме. */
export function buildOutgoingPayload(
  v: BankTransactionReconcilePayload,
  supplierMode: SupplierMode,
): ReconcileTransactionInput {
  switch (v.type) {
    case 'SUPPLIER_PAYMENT':
      return supplierMode === 'existing'
        ? { type: v.type, supplierPaymentId: v.supplierPaymentId }
        : { type: v.type, counterpartyId: v.counterpartyId, purchaseOrderId: v.purchaseOrderId };
    case 'CLIENT_REFUND':
      return { type: v.type, counterpartyId: v.counterpartyId };
    case 'EXPENSE':
      return {
        type: v.type,
        expenseCategoryId: v.expenseCategoryId,
        counterpartyId: v.counterpartyId,
      };
    case 'PAYROLL':
      return { type: v.type, payrollPeriodId: v.payrollPeriodId, employeeId: v.employeeId };
    case 'TRANSFER':
      return { type: v.type, transferBankAccountId: v.transferBankAccountId };
    case 'CASH_WITHDRAWAL':
      return { type: v.type, cashRegisterId: v.cashRegisterId };
  }
}

interface CounterpartyRef {
  id: string;
  companyName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}
interface PurchaseOrderRef {
  id: string;
  number: string;
}
interface EmployeeRef {
  id: string;
  firstName: string;
  lastName: string;
}
interface PickItem {
  id: string;
  primary: string;
}

type CounterpartyPicker = 'supplier' | 'client' | 'any';
type Picker = CounterpartyPicker | 'purchaseOrder' | 'employee' | null;

/** Зарплатні періоди, на які можна рознести платіж (BR-BANK-032). */
const PAYROLL_STATUSES = ['COMPUTED', 'PAID'] as const;
const PAYROLL_PERIODS_FILTER = { limit: 200 } as const;

const ERROR_BOX =
  'text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2';

const asText = (v: unknown): string => (typeof v === 'string' ? v : '');

interface Props {
  form: OutgoingAllocationForm;
  /** Вікно відкрите — довідники обраного виду можна вантажити. */
  enabled: boolean;
  /** Рахунок і валюта платежу: рахунок переказу — інший, каса — тієї самої валюти. */
  bankAccountId?: string | null;
  currencyId?: string | null;
  currencyCode?: string | null;
  labels: OutgoingAllocationLabels;
  onLabelsChange: (next: OutgoingAllocationLabels) => void;
  /**
   * Оплата постачальнику. Є кандидати (вікно рознесення рядка) — перемикач «наявна / нова» і
   * список проведених оплат; немає (вікно створення) — лише нова оплата.
   */
  supplierMode: SupplierMode;
  onSupplierModeChange?: (next: SupplierMode) => void;
  candidatesQuery?: UseQueryResult<SupplierPaymentCandidate[]>;
  /** Прапорець «відкрито пікер» для вікна-власника (Escape у пікері не закриває вікно). */
  pickerOpenRef?: MutableRefObject<boolean>;
}

export function OutgoingAllocationFields({
  form,
  enabled,
  bankAccountId,
  currencyId,
  currencyCode,
  labels,
  onLabelsChange,
  supplierMode,
  onSupplierModeChange,
  candidatesQuery,
  pickerOpenRef,
}: Props) {
  const { t } = useTranslation('bankStatements');
  const {
    control,
    watch,
    setValue,
    getValues,
    clearErrors,
    formState: { errors },
  } = form;

  const type = watch('type');
  const counterpartyId = asText(watch('counterpartyId'));
  const supplierPaymentId = asText(watch('supplierPaymentId'));
  const cashRegisterId = asText(watch('cashRegisterId'));

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
  const setLabels = (patch: Partial<OutgoingAllocationLabels>) =>
    onLabelsChange({ ...labels, ...patch });

  // ── Довідники — лише для обраного виду ──────────────────────────────────────
  const candidates = candidatesQuery?.data;
  const expenseQuery = useExpenseCategories(false, enabled && type === 'EXPENSE');
  const expenseOptions = useMemo(
    () => flattenActiveByType(expenseQuery.data, 'EXPENSE'),
    [expenseQuery.data],
  );
  const accountsQuery = useBankAccountOptions(enabled && type === 'TRANSFER');
  const transferAccounts = useMemo(
    () => (accountsQuery.data ?? []).filter(a => a.id !== bankAccountId),
    [accountsQuery.data, bankAccountId],
  );
  const registersQuery = useQuery({
    queryKey: cashKeys.registers(),
    queryFn: ({ signal }) =>
      apiFetch<{ items: CashRegister[] }>('/cash-registers', { signal }).then(r => r.items),
    enabled: enabled && type === 'CASH_WITHDRAWAL',
    staleTime: 5 * 60_000,
  });
  // BR-BANK-034: готівка потрапляє лише в касу тієї самої валюти, що й платіж.
  const registers = useMemo(
    () => (registersQuery.data ?? []).filter(r => r.currencyId === currencyId),
    [registersQuery.data, currencyId],
  );
  const periodsQuery = useQuery({
    queryKey: payrollKeys.periods(PAYROLL_PERIODS_FILTER),
    queryFn: ({ signal }) =>
      apiFetch<PaginatedPayrollPeriods>(`/payroll/periods?limit=${PAYROLL_PERIODS_FILTER.limit}`, {
        signal,
      }),
    enabled: enabled && type === 'PAYROLL',
  });
  const periods = useMemo(
    () =>
      (periodsQuery.data?.items ?? []).filter(p =>
        (PAYROLL_STATUSES as readonly string[]).includes(p.status),
      ),
    [periodsQuery.data],
  );
  const { data: branches } = useBranches();

  // Рахунок платежу змінився (вікно створення): обраний рахунок переказу чи каса могли стати
  // недопустимими — той самий рахунок або каса іншої валюти. Значення, якого немає серед
  // дозволених варіантів, скидається.
  useEffect(() => {
    if (!accountsQuery.isSuccess) return;
    const current = asText(getValues('transferBankAccountId'));
    if (current && !transferAccounts.some(a => a.id === current))
      setValue('transferBankAccountId', '');
  }, [accountsQuery.isSuccess, transferAccounts, getValues, setValue]);
  useEffect(() => {
    if (!registersQuery.isSuccess) return;
    const current = asText(getValues('cashRegisterId'));
    if (current && !registers.some(r => r.id === current)) setValue('cashRegisterId', '');
  }, [registersQuery.isSuccess, registers, getValues, setValue]);

  const branchName = (id?: string | null) =>
    id ? (branches?.find(b => b.id === id)?.name ?? '—') : t('reconcile.allBranches');

  const counterpartyPickerTypes =
    picker === 'supplier'
      ? '&types=SUPPLIER&types=BOTH'
      : picker === 'client'
        ? '&types=CLIENT&types=BOTH'
        : '';

  const counterpartyField = (kind: CounterpartyPicker, label: string, placeholder: string) => (
    <div>
      <EntityPickerField
        label={label}
        required={kind !== 'any'}
        display={labels.counterpartyName}
        placeholder={placeholder}
        className="h-8 text-[13px]"
        onPick={() => openPicker(kind)}
        onClear={() => {
          setValue('counterpartyId', '');
          // Замовлення належить постачальнику — без нього посилання стає сиротою.
          setValue('purchaseOrderId', '');
          setLabels({ counterpartyName: '', purchaseOrderNumber: '' });
        }}
      />
      {errors.counterpartyId && (
        <p role="alert" className="text-[12px] text-destructive leading-tight mt-1">
          {errors.counterpartyId.message}
        </p>
      )}
    </div>
  );

  const withCandidates = !!candidatesQuery;

  return (
    <>
      {/* ── Оплата постачальнику ─────────────────────────────── */}
      {type === 'SUPPLIER_PAYMENT' && (
        <>
          {withCandidates && (
            <div
              role="group"
              aria-label={t('reconcile.supplierMode.label')}
              className="inline-flex h-8 rounded border border-border overflow-hidden"
            >
              {(['existing', 'new'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={supplierMode === m}
                  onClick={() => onSupplierModeChange?.(m)}
                  className={cn(
                    'px-3 text-[13px] transition-colors',
                    supplierMode === m
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'bg-surface text-muted-foreground hover:bg-secondary',
                  )}
                >
                  {t(`reconcile.supplierMode.${m}`)}
                </button>
              ))}
            </div>
          )}

          {/* Пояснення видно в обох режимах: після автоперемикання на «Створити нову»
              користувач має розуміти, чому прив'язати нема до чого. */}
          {candidatesQuery?.isSuccess && candidates?.length === 0 && (
            <p className="text-[13px] text-muted-foreground">{t('reconcile.candidates.empty')}</p>
          )}

          {withCandidates && supplierMode === 'existing' ? (
            candidatesQuery.isLoading ? (
              <div className="flex justify-center py-4">
                <Spinner size="md" />
              </div>
            ) : candidatesQuery.isError ? (
              <div role="alert" className={ERROR_BOX}>
                {candidatesQuery.error instanceof Error && candidatesQuery.error.message
                  ? candidatesQuery.error.message
                  : t('reconcile.candidates.error')}
              </div>
            ) : !candidates?.length ? null : (
              <fieldset className="flex flex-col gap-1">
                <legend className="text-[13px] font-medium text-foreground mb-1">
                  {t('reconcile.candidates.label')}
                  <span className="ml-0.5 text-destructive">*</span>
                </legend>
                <div className="max-h-48 overflow-auto border border-border rounded-lg divide-y divide-border">
                  {candidates.map(c => (
                    <label
                      key={c.id}
                      className="flex items-center gap-2 px-3 py-2 text-[13px] cursor-pointer hover:bg-secondary/60"
                    >
                      <input
                        type="radio"
                        name="supplierPaymentId"
                        value={c.id}
                        checked={supplierPaymentId === c.id}
                        onChange={() => {
                          setValue('supplierPaymentId', c.id);
                          clearErrors('counterpartyId');
                        }}
                      />
                      <span className="font-medium whitespace-nowrap">{c.number}</span>
                      <span className="text-muted-foreground tabular-nums whitespace-nowrap">
                        {fmtDate(c.documentDate)}
                      </span>
                      <span className="truncate">{c.supplierName}</span>
                      {c.purchaseOrderNumber && (
                        <span className="text-muted-foreground whitespace-nowrap ml-auto">
                          {t('reconcile.candidates.order', {
                            number: c.purchaseOrderNumber,
                          })}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              </fieldset>
            )
          ) : (
            <>
              {counterpartyField(
                'supplier',
                t('reconcile.supplier'),
                t('reconcile.supplierPlaceholder'),
              )}
              <EntityPickerField
                label={t('reconcile.purchaseOrder')}
                display={labels.purchaseOrderNumber}
                placeholder={t('reconcile.purchaseOrderPlaceholder')}
                className="h-8 text-[13px]"
                disabled={!counterpartyId}
                onPick={() => openPicker('purchaseOrder')}
                onClear={() => {
                  setValue('purchaseOrderId', '');
                  setLabels({ purchaseOrderNumber: '' });
                }}
              />
            </>
          )}
          {withCandidates && supplierMode === 'existing' && errors.counterpartyId && (
            <p role="alert" className="text-[12px] text-destructive leading-tight">
              {t('reconcile.candidates.required')}
            </p>
          )}
        </>
      )}

      {/* ── Повернення клієнту ───────────────────────────────── */}
      {type === 'CLIENT_REFUND' &&
        counterpartyField('client', t('reconcile.client'), t('reconcile.clientPlaceholder'))}

      {/* ── Витрата ──────────────────────────────────────────── */}
      {type === 'EXPENSE' && (
        <>
          {expenseQuery.isError && (
            <div role="alert" className={ERROR_BOX}>
              {t('reconcile.refDataError')}
            </div>
          )}
          <Controller
            control={control}
            name="expenseCategoryId"
            render={({ field }) => (
              <Select
                label={t('reconcile.expenseCategory')}
                required
                value={asText(field.value)}
                onChange={field.onChange}
                disabled={expenseQuery.isLoading}
                errorMessage={errors.expenseCategoryId?.message}
                className="h-8 text-[13px]"
              >
                <option value="">{t('reconcile.selectPlaceholder')}</option>
                {expenseOptions.map(c => (
                  <option key={c.id} value={c.id}>
                    {`${'  '.repeat(c.depth)}${c.name}`}
                  </option>
                ))}
              </Select>
            )}
          />
          {counterpartyField(
            'any',
            t('reconcile.counterpartyOptional'),
            t('reconcile.counterpartyPlaceholder'),
          )}
        </>
      )}

      {/* ── Зарплата ─────────────────────────────────────────── */}
      {type === 'PAYROLL' && (
        <>
          {periodsQuery.isError && (
            <div role="alert" className={ERROR_BOX}>
              {t('reconcile.refDataError')}
            </div>
          )}
          <Controller
            control={control}
            name="payrollPeriodId"
            render={({ field }) => (
              <Select
                label={t('reconcile.payrollPeriod')}
                required
                value={asText(field.value)}
                onChange={field.onChange}
                disabled={periodsQuery.isLoading}
                errorMessage={errors.payrollPeriodId?.message}
                hint={
                  periodsQuery.isSuccess && periods.length === 0
                    ? t('reconcile.payrollPeriodsEmpty')
                    : undefined
                }
                className="h-8 text-[13px]"
              >
                <option value="">{t('reconcile.selectPlaceholder')}</option>
                {periods.map(p => (
                  <option key={p.id} value={p.id}>
                    {`${fmtDate(p.periodStart)} – ${fmtDate(p.periodEnd)} · ${branchName(p.branchId)} · ${t(`reconcile.payrollStatus.${p.status}`)}`}
                  </option>
                ))}
              </Select>
            )}
          />
          <EntityPickerField
            label={t('reconcile.employee')}
            display={labels.employeeName}
            placeholder={t('reconcile.employeePlaceholder')}
            className="h-8 text-[13px]"
            onPick={() => openPicker('employee')}
            onClear={() => {
              setValue('employeeId', '');
              setLabels({ employeeName: '' });
            }}
          />
        </>
      )}

      {/* ── Переказ між рахунками ────────────────────────────── */}
      {type === 'TRANSFER' && (
        <>
          {accountsQuery.isError && (
            <div role="alert" className={ERROR_BOX}>
              {t('reconcile.refDataError')}
            </div>
          )}
          <Controller
            control={control}
            name="transferBankAccountId"
            render={({ field }) => (
              <Select
                label={t('reconcile.transferAccount')}
                required
                value={asText(field.value)}
                onChange={field.onChange}
                disabled={accountsQuery.isLoading}
                errorMessage={errors.transferBankAccountId?.message}
                hint={
                  accountsQuery.isSuccess && transferAccounts.length === 0
                    ? t('reconcile.transferAccountsEmpty')
                    : undefined
                }
                className="h-8 text-[13px]"
              >
                <option value="">{t('reconcile.selectPlaceholder')}</option>
                {transferAccounts.map(a => (
                  <option key={a.id} value={a.id}>
                    {`${a.name} (${a.currencyCode})`}
                  </option>
                ))}
              </Select>
            )}
          />
        </>
      )}

      {/* ── Зняття готівки ───────────────────────────────────── */}
      {type === 'CASH_WITHDRAWAL' && (
        <>
          {registersQuery.isError && (
            <div role="alert" className={ERROR_BOX}>
              {t('reconcile.refDataError')}
            </div>
          )}
          {registersQuery.isSuccess && registers.length === 0 ? (
            <p
              role="note"
              className="text-[13px] text-warning bg-warning-subtle border border-warning/30 rounded-lg px-3 py-2"
            >
              {t('reconcile.cashRegistersEmpty', { currency: currencyCode ?? 'UAH' })}
            </p>
          ) : null}
          <Controller
            control={control}
            name="cashRegisterId"
            render={({ field }) => (
              <Select
                label={t('reconcile.cashRegister')}
                required
                value={cashRegisterId}
                onChange={e => {
                  field.onChange(e);
                  setLabels({
                    cashRegisterName: registers.find(r => r.id === e.target.value)?.name ?? '',
                  });
                }}
                disabled={registersQuery.isLoading}
                errorMessage={errors.cashRegisterId?.message}
                className="h-8 text-[13px]"
              >
                <option value="">{t('reconcile.selectPlaceholder')}</option>
                {registers.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            )}
          />
        </>
      )}

      {/* Контрагент: постачальник / клієнт / будь-який — за видом рознесення */}
      <SearchPickerModal
        open={picker === 'supplier' || picker === 'client' || picker === 'any'}
        onClose={closePicker}
        selectedId={counterpartyId || null}
        onSelect={(item: PickItem) => {
          setValue('counterpartyId', item.id, { shouldValidate: !!errors.counterpartyId });
          // Замовлення належить конкретному постачальнику.
          setValue('purchaseOrderId', '');
          setLabels({ counterpartyName: item.primary, purchaseOrderNumber: '' });
          closePicker();
        }}
        title={
          picker === 'supplier'
            ? t('reconcile.pickSupplier')
            : picker === 'client'
              ? t('reconcile.pickClient')
              : t('reconcile.pickCounterparty')
        }
        fetchItems={q =>
          apiFetch<{ items: CounterpartyRef[] }>(
            `/counterparties?q=${encodeURIComponent(q)}${counterpartyPickerTypes}&limit=30`,
          ).then(d => d.items.map(c => ({ id: c.id, primary: displayCounterpartyName(c) })))
        }
      />

      <SearchPickerModal
        open={picker === 'purchaseOrder'}
        onClose={closePicker}
        onSelect={(item: PickItem) => {
          setValue('purchaseOrderId', item.id);
          setLabels({ purchaseOrderNumber: item.primary });
          closePicker();
        }}
        title={t('reconcile.pickPurchaseOrder')}
        fetchItems={q =>
          apiFetch<{ items: PurchaseOrderRef[] }>(
            `/purchase-orders?q=${encodeURIComponent(q)}&supplierId=${counterpartyId}&limit=30`,
          ).then(d => d.items.map(po => ({ id: po.id, primary: po.number })))
        }
      />

      <SearchPickerModal
        open={picker === 'employee'}
        onClose={closePicker}
        onSelect={(item: PickItem) => {
          setValue('employeeId', item.id);
          setLabels({ employeeName: item.primary });
          closePicker();
        }}
        title={t('reconcile.pickEmployee')}
        fetchItems={q =>
          apiFetch<{ items: EmployeeRef[] }>(
            `/employees?q=${encodeURIComponent(q)}&page=1&limit=30`,
          ).then(d =>
            d.items.map(e => ({ id: e.id, primary: `${e.lastName} ${e.firstName}`.trim() })),
          )
        }
      />
    </>
  );
}
