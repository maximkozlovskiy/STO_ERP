'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import {
  BANK_TX_OUT_MATCH_TYPE_VALUES,
  BANK_TX_POSTING_MATCH_TYPES,
  bankTransactionReconcileFormSchema,
  type BankTransactionReconcileFormValues,
  type BankTransactionReconcilePayload,
  type BankTxOutMatchTypeValue,
} from '@sto/shared';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { cn, displayCounterpartyName } from '@/lib/utils';
import { fmtMoney, fmtDate, fmtBankCurrencySuffix } from '@/lib/format';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal } from '@/components/ui/search-picker-modal';
import { bankTxMatchTypeLabel } from '@/i18n/enumLabel';
import {
  useBankAccountOptions,
  useReconcileBankTransaction,
  useSupplierPaymentCandidates,
  type BankTransaction,
  type ReconcileTransactionInput,
} from '@/hooks/api/useBankStatements';
import { cashKeys, type CashRegister } from '@/hooks/api/useCash';
import { useExpenseCategories, flattenActiveByType } from '@/hooks/api/useExpenseCategories';
import { payrollKeys, type PaginatedPayrollPeriods } from '@/hooks/api/usePayroll';
import { useBranches } from '@/hooks/api/useInfrastructure';

interface Props {
  open: boolean;
  onClose: () => void;
  transaction: BankTransaction | null;
  /**
   * Обмежує перелік видів. Для вхідного рядка — лише `['TRANSFER']` (BR-BANK-025):
   * решта видів `reconcile` дозволена тільки для вихідного.
   */
  allowedTypes?: readonly BankTxOutMatchTypeValue[];
  onReconciled?: () => void;
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

type SupplierMode = 'existing' | 'new';
type CounterpartyPicker = 'supplier' | 'client' | 'any';

/** Зарплатні періоди, на які можна рознести платіж (BR-BANK-032). */
const PAYROLL_STATUSES = ['COMPUTED', 'PAID'] as const;
const PAYROLL_PERIODS_FILTER = { limit: 200 } as const;

const ID_FIELDS = [
  'counterpartyId',
  'supplierPaymentId',
  'purchaseOrderId',
  'expenseCategoryId',
  'payrollPeriodId',
  'employeeId',
  'transferBankAccountId',
  'cashRegisterId',
] as const;

const emptyDefaults = (type: BankTxOutMatchTypeValue): BankTransactionReconcileFormValues => ({
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

const asText = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Лише поля, що стосуються обраного виду: зайве посилання бекенд відхилить або, гірше, прийме. */
function buildPayload(
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

const ERROR_BOX =
  'text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2';

/**
 * Рознесення вихідного платежу за видом (BR-BANK-025…034) і переказу між рахунками для
 * вхідного. Суму, рахунок, валюту й дату бекенд бере З РЯДКА (BR-BANK-026) — форма шле лише
 * вид і посилання. Види, що створюють проведення чи касову операцію, просять підтвердження.
 */
export function MatchOutgoingBankTransactionModal({
  open,
  onClose,
  transaction,
  allowedTypes,
  onReconciled,
}: Props) {
  const { t } = useTranslation('bankStatements');
  const reconcileMut = useReconcileBankTransaction();

  const types = useMemo<readonly BankTxOutMatchTypeValue[]>(
    () =>
      allowedTypes?.length
        ? BANK_TX_OUT_MATCH_TYPE_VALUES.filter(v => allowedTypes.includes(v))
        : BANK_TX_OUT_MATCH_TYPE_VALUES,
    [allowedTypes],
  );
  const initialType = types[0] ?? 'SUPPLIER_PAYMENT';

  const {
    control,
    reset,
    watch,
    setValue,
    clearErrors,
    handleSubmit,
    formState: { errors },
  } = useForm<BankTransactionReconcileFormValues, unknown, BankTransactionReconcilePayload>({
    resolver: i18nZodResolver(bankTransactionReconcileFormSchema),
    defaultValues: emptyDefaults(initialType),
  });

  const type = watch('type');
  const counterpartyId = asText(watch('counterpartyId'));
  const supplierPaymentId = asText(watch('supplierPaymentId'));
  const cashRegisterId = asText(watch('cashRegisterId'));

  const [supplierMode, setSupplierMode] = useState<SupplierMode>('existing');
  const [counterpartyName, setCounterpartyName] = useState('');
  const [purchaseOrderNumber, setPurchaseOrderNumber] = useState('');
  const [employeeName, setEmployeeName] = useState('');
  const [cpPicker, setCpPicker] = useState<CounterpartyPicker | null>(null);
  const [poPickerOpen, setPoPickerOpen] = useState(false);
  const [employeePickerOpen, setEmployeePickerOpen] = useState(false);
  const [error, setError] = useState('');
  // Крок підтвердження: payload уже зібрано й перевірено, чекає на «Підтвердити».
  const [pending, setPending] = useState<ReconcileTransactionInput | null>(null);
  // Автоперемикання на «Створити нову» — раз на відкриття: інакше користувач не зміг би
  // повернутись на «наявну» і побачити пояснення, чому список порожній.
  const autoSwitchedRef = useRef(false);
  const submittingRef = useRef(false);

  const txId = transaction?.id;

  // ── Довідники — лише для обраного виду ──────────────────────────────────────
  const candidatesQuery = useSupplierPaymentCandidates(txId, open && type === 'SUPPLIER_PAYMENT');
  const candidates = candidatesQuery.data;
  const expenseQuery = useExpenseCategories(false, open && type === 'EXPENSE');
  const expenseOptions = useMemo(
    () => flattenActiveByType(expenseQuery.data, 'EXPENSE'),
    [expenseQuery.data],
  );
  const accountsQuery = useBankAccountOptions(open && type === 'TRANSFER');
  const transferAccounts = useMemo(
    () => (accountsQuery.data ?? []).filter(a => a.id !== transaction?.bankAccountId),
    [accountsQuery.data, transaction?.bankAccountId],
  );
  const registersQuery = useQuery({
    queryKey: cashKeys.registers(),
    queryFn: ({ signal }) =>
      apiFetch<{ items: CashRegister[] }>('/cash-registers', { signal }).then(r => r.items),
    enabled: open && type === 'CASH_WITHDRAWAL',
    staleTime: 5 * 60_000,
  });
  // BR-BANK-034: готівка потрапляє лише в касу тієї самої валюти, що й рядок.
  const registers = useMemo(
    () => (registersQuery.data ?? []).filter(r => r.currencyId === transaction?.currencyId),
    [registersQuery.data, transaction?.currencyId],
  );
  const periodsQuery = useQuery({
    queryKey: payrollKeys.periods(PAYROLL_PERIODS_FILTER),
    queryFn: ({ signal }) =>
      apiFetch<PaginatedPayrollPeriods>(`/payroll/periods?limit=${PAYROLL_PERIODS_FILTER.limit}`, {
        signal,
      }),
    enabled: open && type === 'PAYROLL',
  });
  const periods = useMemo(
    () =>
      (periodsQuery.data?.items ?? []).filter(p =>
        (PAYROLL_STATUSES as readonly string[]).includes(p.status),
      ),
    [periodsQuery.data],
  );
  const { data: branches } = useBranches();

  const clearLinks = () => {
    for (const f of ID_FIELDS) setValue(f, '');
    setCounterpartyName('');
    setPurchaseOrderNumber('');
    setEmployeeName('');
    clearErrors();
    setError('');
  };

  useEffect(() => {
    if (!open) return;
    reset(emptyDefaults(initialType));
    setSupplierMode('existing');
    setCounterpartyName('');
    setPurchaseOrderNumber('');
    setEmployeeName('');
    setCpPicker(null);
    setPoPickerOpen(false);
    setEmployeePickerOpen(false);
    setError('');
    setPending(null);
    autoSwitchedRef.current = false;
    submittingRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, txId]);

  // Немає проведених оплат на цю суму → прив'язувати нема до чого, одразу «Створити нову».
  useEffect(() => {
    if (!open || type !== 'SUPPLIER_PAYMENT' || autoSwitchedRef.current) return;
    if (candidates && candidates.length === 0) {
      autoSwitchedRef.current = true;
      setSupplierMode('new');
    }
  }, [open, type, candidates]);

  const changeType = (next: BankTxOutMatchTypeValue) => {
    setValue('type', next);
    clearLinks();
    setSupplierMode(candidates && candidates.length === 0 ? 'new' : 'existing');
  };

  const changeSupplierMode = (next: SupplierMode) => {
    autoSwitchedRef.current = true;
    setSupplierMode(next);
    clearLinks();
  };

  const amountText = transaction
    ? `${fmtMoney(transaction.amount)} ${fmtBankCurrencySuffix(transaction.bankAccountCurrencyCode)}`
    : '';

  const send = async (data: ReconcileTransactionInput) => {
    if (!transaction || submittingRef.current) return;
    submittingRef.current = true;
    setError('');
    try {
      await reconcileMut.mutateAsync({ id: transaction.id, data });
      toast.success(t('reconcile.success'));
      onReconciled?.();
      onClose();
    } catch (e) {
      // Текст відмови — з відповіді сервера (409 «уже рознесено», 400 про касу тощо).
      // Список хук оновлює сам (onSettled): після 409 рядок у ньому застарів.
      setError(e instanceof Error && e.message ? e.message : t('reconcile.error'));
      setPending(null);
    } finally {
      submittingRef.current = false;
    }
  };

  const onValid = (values: BankTransactionReconcilePayload) => {
    const data = buildPayload(values, supplierMode);
    // Прив'язка наявної оплати нічого не проводить (BR-BANK-027) — підтверджувати нічого.
    const posts = BANK_TX_POSTING_MATCH_TYPES.has(data.type) && !data.supplierPaymentId;
    if (posts) {
      setError('');
      setPending(data);
      return;
    }
    void send(data);
  };

  const submit = handleSubmit(onValid);
  const busy = reconcileMut.isPending;
  const close = () => {
    if (!busy) onClose();
  };

  const confirmName =
    pending?.type === 'CASH_WITHDRAWAL'
      ? (registers.find(r => r.id === pending.cashRegisterId)?.name ?? '')
      : counterpartyName;

  const branchName = (id?: string | null) =>
    id ? (branches?.find(b => b.id === id)?.name ?? '—') : t('reconcile.allBranches');

  const counterpartyPickerTypes =
    cpPicker === 'supplier'
      ? '&types=SUPPLIER&types=BOTH'
      : cpPicker === 'client'
        ? '&types=CLIENT&types=BOTH'
        : '';

  const counterpartyField = (kind: CounterpartyPicker, label: string, placeholder: string) => (
    <div>
      <EntityPickerField
        label={label}
        required={kind !== 'any'}
        display={counterpartyName}
        placeholder={placeholder}
        className="h-8 text-[13px]"
        onPick={() => setCpPicker(kind)}
        onClear={() => {
          setValue('counterpartyId', '');
          setCounterpartyName('');
          // Замовлення належить постачальнику — без нього посилання стає сиротою.
          setValue('purchaseOrderId', '');
          setPurchaseOrderNumber('');
        }}
      />
      {errors.counterpartyId && (
        <p role="alert" className="text-[12px] text-destructive leading-tight mt-1">
          {errors.counterpartyId.message}
        </p>
      )}
    </div>
  );

  return (
    <>
      <Modal
        open={open}
        onClose={close}
        onSubmit={() => (pending ? void send(pending) : void submit())}
        title={
          pending
            ? t('reconcile.confirmTitle')
            : types.length === 1 && types[0] === 'TRANSFER'
              ? t('reconcile.titleTransfer')
              : t('reconcile.title')
        }
        size="lg"
        footer={
          <div className="flex gap-2 items-center justify-end w-full">
            {pending ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPending(null)}
                  disabled={busy}
                >
                  {t('reconcile.back')}
                </Button>
                <Button size="sm" onClick={() => void send(pending)} loading={busy} disabled={busy}>
                  {t('reconcile.confirmSubmit')}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={close} disabled={busy}>
                  {t('reconcile.cancel')}
                </Button>
                <Button size="sm" onClick={() => void submit()} loading={busy} disabled={busy}>
                  {t('reconcile.submit')}
                </Button>
              </>
            )}
          </div>
        }
      >
        <div className="space-y-4">
          {transaction && (
            <dl className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-[13px] space-y-1">
              <div className="flex items-center justify-between gap-3">
                <dd className="text-muted-foreground tabular-nums">
                  {fmtDate(transaction.operationDate)}
                </dd>
                <dd className="font-semibold tabular-nums whitespace-nowrap">{amountText}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground shrink-0">
                  {t('reconcile.statementCounterparty')}:
                </dt>
                <dd className="truncate">{transaction.payerName ?? '—'}</dd>
              </div>
              {transaction.purpose && (
                <div className="flex gap-2">
                  <dt className="text-muted-foreground shrink-0">
                    {t('reconcile.statementPurpose')}:
                  </dt>
                  <dd className="truncate" title={transaction.purpose}>
                    {transaction.purpose}
                  </dd>
                </div>
              )}
            </dl>
          )}

          {error && (
            <div role="alert" className={ERROR_BOX}>
              {error}
            </div>
          )}

          {pending ? (
            <p
              role="note"
              className="text-[13px] text-warning bg-warning-subtle border border-warning/30 rounded-lg px-3 py-2"
            >
              {t(`reconcile.confirm.${pending.type}`, { name: confirmName, amount: amountText })}
            </p>
          ) : (
            <>
              <Controller
                control={control}
                name="type"
                render={({ field }) => (
                  <Select
                    label={t('reconcile.type')}
                    required
                    value={field.value}
                    disabled={types.length === 1}
                    onChange={e => changeType(e.target.value as BankTxOutMatchTypeValue)}
                    errorMessage={errors.type?.message}
                    className="h-8 text-[13px]"
                  >
                    {types.map(mt => (
                      <option key={mt} value={mt}>
                        {bankTxMatchTypeLabel(mt)}
                      </option>
                    ))}
                  </Select>
                )}
              />

              {/* ── Оплата постачальнику ─────────────────────────────── */}
              {type === 'SUPPLIER_PAYMENT' && (
                <>
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
                        onClick={() => changeSupplierMode(m)}
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

                  {/* Пояснення видно в обох режимах: після автоперемикання на «Створити нову»
                      користувач має розуміти, чому прив'язати нема до чого. */}
                  {candidatesQuery.isSuccess && candidates?.length === 0 && (
                    <p className="text-[13px] text-muted-foreground">
                      {t('reconcile.candidates.empty')}
                    </p>
                  )}

                  {supplierMode === 'existing' ? (
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
                        display={purchaseOrderNumber}
                        placeholder={t('reconcile.purchaseOrderPlaceholder')}
                        className="h-8 text-[13px]"
                        disabled={!counterpartyId}
                        onPick={() => setPoPickerOpen(true)}
                        onClear={() => {
                          setValue('purchaseOrderId', '');
                          setPurchaseOrderNumber('');
                        }}
                      />
                    </>
                  )}
                  {supplierMode === 'existing' && errors.counterpartyId && (
                    <p role="alert" className="text-[12px] text-destructive leading-tight">
                      {t('reconcile.candidates.required')}
                    </p>
                  )}
                </>
              )}

              {/* ── Повернення клієнту ───────────────────────────────── */}
              {type === 'CLIENT_REFUND' &&
                counterpartyField(
                  'client',
                  t('reconcile.client'),
                  t('reconcile.clientPlaceholder'),
                )}

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
                            {`${'  '.repeat(c.depth)}${c.name}`}
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
                    display={employeeName}
                    placeholder={t('reconcile.employeePlaceholder')}
                    className="h-8 text-[13px]"
                    onPick={() => setEmployeePickerOpen(true)}
                    onClear={() => {
                      setValue('employeeId', '');
                      setEmployeeName('');
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
                      {t('reconcile.cashRegistersEmpty', {
                        currency: transaction?.bankAccountCurrencyCode ?? 'UAH',
                      })}
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
                        onChange={field.onChange}
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
            </>
          )}
        </div>
      </Modal>

      {/* Контрагент: постачальник / клієнт / будь-який — за видом рознесення */}
      <SearchPickerModal
        open={cpPicker !== null}
        onClose={() => setCpPicker(null)}
        selectedId={counterpartyId || null}
        onSelect={(item: PickItem) => {
          setValue('counterpartyId', item.id, { shouldValidate: !!errors.counterpartyId });
          setCounterpartyName(item.primary);
          // Замовлення належить конкретному постачальнику.
          setValue('purchaseOrderId', '');
          setPurchaseOrderNumber('');
          setCpPicker(null);
        }}
        title={
          cpPicker === 'supplier'
            ? t('reconcile.pickSupplier')
            : cpPicker === 'client'
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
        open={poPickerOpen}
        onClose={() => setPoPickerOpen(false)}
        onSelect={(item: PickItem) => {
          setValue('purchaseOrderId', item.id);
          setPurchaseOrderNumber(item.primary);
          setPoPickerOpen(false);
        }}
        title={t('reconcile.pickPurchaseOrder')}
        fetchItems={q =>
          apiFetch<{ items: PurchaseOrderRef[] }>(
            `/purchase-orders?q=${encodeURIComponent(q)}&supplierId=${counterpartyId}&limit=30`,
          ).then(d => d.items.map(po => ({ id: po.id, primary: po.number })))
        }
      />

      <SearchPickerModal
        open={employeePickerOpen}
        onClose={() => setEmployeePickerOpen(false)}
        onSelect={(item: PickItem) => {
          setValue('employeeId', item.id);
          setEmployeeName(item.primary);
          setEmployeePickerOpen(false);
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
