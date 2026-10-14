'use client';

import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm, Controller } from 'react-hook-form';
import {
  BANK_TX_ALLOCATION_TYPES_BY_DIRECTION,
  BANK_TX_CREATE_CONFIRM_TYPES,
  BANK_TX_DIRECTION_VALUES,
  BANK_TX_REASON_MAX_LENGTH,
  bankTransactionCreateFormSchema,
  bankTransactionCreateOutgoingAllocationFormSchema,
  bankTransactionIncomingAllocationSchema,
  isBankTxInMatchType,
  translateValidation,
  type BankTransactionCreateFormValues,
  type BankTransactionCreatePayload,
  type BankTransactionReconcileFormValues,
  type BankTransactionReconcilePayload,
  type BankTxAllocationTypeValue,
  type BankTxDirectionValue,
} from '@sto/shared';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { getCurrentLocale } from '@/i18n/locale';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { kyivToday, fmtBankCurrencySuffix, fmtMoney } from '@/lib/format';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import {
  IncomingAllocationFields,
  emptyIncomingAllocation,
  type IncomingAllocationValue,
} from '@/components/ui/IncomingAllocationFields';
import {
  EMPTY_OUTGOING_LABELS,
  OutgoingAllocationFields,
  buildOutgoingPayload,
  emptyOutgoingAllocation,
  type OutgoingAllocationLabels,
} from '@/components/ui/OutgoingAllocationFields';
import { bankTxDirectionLabel, bankTxMatchTypeLabel } from '@/i18n/enumLabel';
import {
  useBankAccountOptions,
  useCreateBankTransaction,
  type BankTxDirection,
  type CreateBankTransactionInput,
} from '@/hooks/api/useBankStatements';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Напрям за замовчуванням — напрям вкладки списку; без нього — вхідний. */
  defaultDirection?: BankTxDirection;
  onCreated?: () => void;
}

type AllocationBody = NonNullable<CreateBankTransactionInput['allocation']>;

/** Крок підтвердження: тіло запиту зібрано й перевірено, чекає на «Підтвердити». */
interface PendingConfirm {
  data: CreateBankTransactionInput;
  type: AllocationBody['type'];
  name: string;
  amount: string;
}

interface IncomingErrors {
  counterpartyId?: string;
  invoiceId?: string;
}

// crypto.randomUUID є лише в secure context; on-prem сервер СТО відкривають по http у LAN.
const newIdempotencyKey = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

const emptyDefaults = (direction: BankTxDirection): BankTransactionCreateFormValues => ({
  bankAccountId: '',
  direction,
  amount: '',
  operationDate: kyivToday(),
  payerName: '',
  payerIban: '',
  payerEdrpou: '',
  purpose: '',
});

const asText = (v: unknown): string => (typeof v === 'string' ? v : '');
/** Сума з поля (UA-кома) — як `moneyString` у схемі; нерозбірна → NaN. */
const amountOf = (v: unknown): number => Number(asText(v).trim().replace(',', '.') || NaN);

const allowedTypes = (direction: BankTxDirectionValue): readonly BankTxAllocationTypeValue[] =>
  BANK_TX_ALLOCATION_TYPES_BY_DIRECTION[direction];

/**
 * Ручне внесення банківського платежу (BR-BANK-023): рядок `MANUAL`, будь-якого напряму,
 * у валюті рахунку. Необов'язковий розділ «Рознести як» (BR-BANK-041): одна дія — платіж
 * внесено й рознесено; не вдалося рознести — платежу немає, помилка лишається у вікні.
 */
export function BankTransactionCreateModal({ open, onClose, defaultDirection, onCreated }: Props) {
  const { t } = useTranslation('bankStatements');
  const createMut = useCreateBankTransaction();
  const accountsQuery = useBankAccountOptions(open);
  const accounts = accountsQuery.data;
  const purposeId = useId();
  const features = useUiFeatures();
  // Закриття з уведеним питає підтвердження — як в інших картках документів (Bug #862, #853).
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  const {
    control,
    register,
    reset,
    watch,
    setValue,
    getValues,
    handleSubmit,
    formState: { errors },
  } = useForm<BankTransactionCreateFormValues, unknown, BankTransactionCreatePayload>({
    resolver: i18nZodResolver(bankTransactionCreateFormSchema),
    defaultValues: emptyDefaults(defaultDirection ?? 'IN'),
    mode: 'onBlur',
  });

  // ── «Рознести як» ───────────────────────────────────────────────────────────
  const outForm = useForm<
    BankTransactionReconcileFormValues,
    unknown,
    BankTransactionReconcilePayload
  >({
    resolver: i18nZodResolver(bankTransactionCreateOutgoingAllocationFormSchema),
    defaultValues: emptyOutgoingAllocation('EXPENSE'),
  });
  const [allocType, setAllocType] = useState<BankTxAllocationTypeValue | ''>('');
  const [incoming, setIncoming] = useState<IncomingAllocationValue>(emptyIncomingAllocation);
  const [incomingErrors, setIncomingErrors] = useState<IncomingErrors>({});
  const [outLabels, setOutLabels] = useState<OutgoingAllocationLabels>(EMPTY_OUTGOING_LABELS);
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const [error, setError] = useState('');
  // Один ключ на відкриття форми: повторний клік після обриву на відповіді не створить
  // другий платіж (BR-BANK-023). Нове відкриття — новий платіж, отже й новий ключ.
  const idempotencyKeyRef = useRef('');
  // Синхронний guard від подвійного кліку в одному tick-у (disabled ще не застосувався).
  const savingRef = useRef(false);
  const autoSelectedRef = useRef(false);
  // Escape у пікері контрагента / рахунку не має закривати саме вікно з уведеним
  // (docs/GOTCHAS.md, 2026-10-12): прапорець ставлять і знімають поля рознесення.
  const pickerOpenRef = useRef(false);
  // Поки відкрито запит «Є незбережені зміни», Escape — його, а не цього вікна.
  const closingRef = useRef(false);

  const clearAllocation = () => {
    setAllocType('');
    setIncoming(emptyIncomingAllocation());
    setIncomingErrors({});
    outForm.reset(emptyOutgoingAllocation('EXPENSE'));
    setOutLabels(EMPTY_OUTGOING_LABELS);
  };

  useEffect(() => {
    if (!open) return;
    reset(emptyDefaults(defaultDirection ?? 'IN'));
    clearAllocation();
    setPending(null);
    setError('');
    idempotencyKeyRef.current = newIdempotencyKey();
    savingRef.current = false;
    autoSelectedRef.current = false;
    pickerOpenRef.current = false;
    closingRef.current = false;
    dirty.resetDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Єдиний рахунок обираємо самі — раз на відкриття, щоб не перевибирати очищене поле.
  useEffect(() => {
    if (!open || autoSelectedRef.current || accounts?.length !== 1) return;
    autoSelectedRef.current = true;
    setValue('bankAccountId', accounts[0].id, { shouldDirty: false });
  }, [open, accounts, setValue]);

  const bankAccountId = watch('bankAccountId');
  const direction = watch('direction');
  const purpose = asText(watch('purpose'));
  const account = accounts?.find(a => a.id === bankAccountId);
  const allocKind = allocType === '' ? null : isBankTxInMatchType(allocType) ? 'in' : 'out';

  const changeAllocType = (next: BankTxAllocationTypeValue | '') => {
    setIncomingErrors({});
    setOutLabels(EMPTY_OUTGOING_LABELS);
    if (next === '' || !isBankTxInMatchType(next)) {
      setIncoming(emptyIncomingAllocation());
      outForm.reset(emptyOutgoingAllocation(next === '' ? 'EXPENSE' : next));
    } else {
      // Між вхідними видами контрагент лишається; рахунок — лише для «Оплати рахунку».
      setIncoming(prev =>
        next === 'INVOICE'
          ? { ...prev, type: next }
          : { ...emptyIncomingAllocation(next, prev.counterpartyId, prev.counterpartyName) },
      );
    }
    setAllocType(next);
  };

  // Зміна напряму скидає вид, який для нового напряму не дозволений (BR-BANK-025).
  const changeDirection = (next: BankTxDirectionValue) => {
    setValue('direction', next, { shouldDirty: true });
    if (allocType !== '' && !allowedTypes(next).includes(allocType)) clearAllocation();
  };

  // Сума більша за залишок обраного рахунку клієнта — рахунок уже не підходить.
  const onAmountChange = (raw: string) => {
    const amount = amountOf(raw);
    setIncoming(prev =>
      prev.type === 'INVOICE' &&
      prev.invoiceId &&
      prev.invoiceRemaining != null &&
      amount > prev.invoiceRemaining + 1e-9
        ? { ...prev, invoiceId: '', invoiceNumber: '', invoiceRemaining: null }
        : prev,
    );
  };

  const send = async (data: CreateBankTransactionInput) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setError('');
    try {
      await createMut.mutateAsync({ data, idempotencyKey: idempotencyKeyRef.current });
      toast.success(t(data.allocation ? 'create.allocation.success' : 'create.success'));
      onCreated?.();
      onClose();
    } catch (e) {
      // Текст відмови — з відповіді сервера; платіж при відмові рознесення не внесено.
      setError(e instanceof Error && e.message ? e.message : t('create.error'));
      setPending(null);
    } finally {
      savingRef.current = false;
    }
  };

  /** Поля вхідного виду через спільну схему; помилки — під полями. */
  const incomingAllocation = (amount: number): AllocationBody | null => {
    const parsed = bankTransactionIncomingAllocationSchema.safeParse(incoming);
    if (!parsed.success) {
      const locale = getCurrentLocale();
      const next: IncomingErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'counterpartyId' || field === 'invoiceId')
          next[field] ??= translateValidation(issue.message, locale);
      }
      setIncomingErrors(next);
      return null;
    }
    const v = parsed.data;
    // Сума, більша за залишок рахунку, — за будь-якого порядку вводу (Bug #863): скидання рахунку
    // при зміні суми не ловить рахунок, обраний ПІСЛЯ суми.
    if (
      v.type === 'INVOICE' &&
      incoming.invoiceRemaining != null &&
      amount > incoming.invoiceRemaining + 1e-9
    ) {
      setIncomingErrors({
        invoiceId: t('create.allocation.invoiceExceeds', {
          remaining: fmtMoney(incoming.invoiceRemaining),
        }),
      });
      return null;
    }
    setIncomingErrors({});
    return {
      type: v.type,
      counterpartyId: v.counterpartyId,
      invoiceId: v.type === 'INVOICE' ? v.invoiceId : undefined,
    };
  };

  /** Поля вихідного виду через форму виду (та сама схема, що й у вікні рознесення). */
  const outgoingAllocation = (): Promise<AllocationBody | null> =>
    new Promise(resolve => {
      void outForm.handleSubmit(
        v => resolve(buildOutgoingPayload(v, 'new')),
        () => resolve(null),
      )();
    });

  const onValid = async (values: BankTransactionCreatePayload) => {
    const data: CreateBankTransactionInput = {
      bankAccountId: values.bankAccountId,
      direction: values.direction,
      amount: values.amount,
      operationDate: values.operationDate,
      payerName: values.payerName?.trim() || undefined,
      payerIban: values.payerIban?.trim() || undefined,
      payerEdrpou: values.payerEdrpou?.trim() || undefined,
      purpose: values.purpose?.trim() || undefined,
    };
    if (!allocKind) return send(data);

    const allocation =
      allocKind === 'in' ? incomingAllocation(values.amount) : await outgoingAllocation();
    if (!allocation) return;
    const withAllocation = { ...data, allocation };
    if (!BANK_TX_CREATE_CONFIRM_TYPES.has(allocation.type)) return send(withAllocation);

    setError('');
    setPending({
      data: withAllocation,
      type: allocation.type,
      name:
        allocation.type === 'INVOICE'
          ? incoming.invoiceNumber
          : allocation.type === 'CASH_WITHDRAWAL'
            ? outLabels.cashRegisterName
            : outLabels.counterpartyName,
      amount: `${fmtMoney(values.amount)} ${fmtBankCurrencySuffix(account?.currencyCode)}`,
    });
  };

  const submit = handleSubmit(onValid);
  const busy = createMut.isPending;

  /**
   * Чи є у вікні щось, уведене людиною: сума, реквізити, призначення, вид рознесення (і крок
   * підтвердження). Рахунок, напрям і дата мають типові значення — порожнє вікно з іншим
   * рахунком закривається без запиту.
   */
  const hasInput = () => {
    const v = getValues();
    return (
      allocType !== '' ||
      pending !== null ||
      [v.amount, v.payerName, v.payerIban, v.payerEdrpou, v.purpose].some(
        x => asText(x).trim() !== '',
      )
    );
  };

  // Стабільний onClose для Modal: його keydown-слухач не переприв'язується на кожен рендер.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const hasInputRef = useRef(hasInput);
  hasInputRef.current = hasInput;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const close = useCallback(async () => {
    if (pickerOpenRef.current || busyRef.current || closingRef.current) return;
    const guard = dirtyRef.current;
    if (hasInputRef.current()) guard.markDirty();
    else guard.resetDirty();
    closingRef.current = true;
    const leave = await guard.confirmClose();
    // Знімається ПІСЛЯ події: той самий Escape, що закрив запит, не має закрити й вікно.
    setTimeout(() => {
      closingRef.current = false;
    }, 0);
    if (leave) onCloseRef.current();
  }, []);
  const requestClose = useCallback(() => void close(), [close]);

  const confirmText = pending
    ? pending.type === 'INVOICE'
      ? t('create.allocation.confirmInvoice', {
          name: pending.name,
          client: incoming.counterpartyName,
          amount: pending.amount,
        })
      : t(`reconcile.confirm.${pending.type}`, { name: pending.name, amount: pending.amount })
    : '';

  return (
    <Modal
      open={open}
      onClose={requestClose}
      onSubmit={() => (pending ? void send(pending.data) : void submit())}
      title={pending ? t('create.allocation.confirmTitle') : t('create.title')}
      size="lg"
      footer={
        <div className="flex gap-2 items-center justify-end w-full">
          {pending ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setPending(null)} disabled={busy}>
                {t('reconcile.back')}
              </Button>
              <Button
                size="sm"
                onClick={() => void send(pending.data)}
                loading={busy}
                disabled={busy}
              >
                {t('reconcile.confirmSubmit')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={requestClose} disabled={busy}>
                {t('create.cancel')}
              </Button>
              <Button size="sm" onClick={() => void submit()} loading={busy} disabled={busy}>
                {allocKind ? t('create.allocation.submit') : t('create.submit')}
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {error && (
          <div
            role="alert"
            className="text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2"
          >
            {error}
          </div>
        )}
        {accountsQuery.isError && (
          <div
            role="alert"
            className="text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2"
          >
            {t('create.accountsError')}
          </div>
        )}

        {pending ? (
          <p
            role="note"
            className="text-[13px] text-warning bg-warning-subtle border border-warning/30 rounded-lg px-3 py-2"
          >
            {confirmText}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Controller
                control={control}
                name="bankAccountId"
                render={({ field }) => (
                  <Select
                    label={t('create.bankAccount')}
                    required
                    value={asText(field.value)}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    disabled={accountsQuery.isLoading}
                    errorMessage={errors.bankAccountId?.message}
                    hint={
                      account
                        ? t('create.accountCurrency', { code: account.currencyCode })
                        : accounts?.length === 0
                          ? t('create.noAccounts')
                          : undefined
                    }
                    className="h-8 text-[13px]"
                  >
                    <option value="">{t('create.bankAccountPlaceholder')}</option>
                    {(accounts ?? []).map(a => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                )}
              />

              <div className="flex flex-col gap-1">
                <span className="text-[13px] font-medium text-foreground leading-none">
                  {t('create.direction')}
                  <span className="ml-0.5 text-destructive">*</span>
                </span>
                <div
                  role="group"
                  aria-label={t('create.direction')}
                  className="inline-flex h-8 rounded border border-border overflow-hidden"
                >
                  {BANK_TX_DIRECTION_VALUES.map(d => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={direction === d}
                      onClick={() => changeDirection(d)}
                      className={cn(
                        'flex-1 px-3 text-[13px] transition-colors',
                        direction === d
                          ? 'bg-primary text-primary-foreground font-medium'
                          : 'bg-surface text-muted-foreground hover:bg-secondary',
                      )}
                    >
                      {bankTxDirectionLabel(d)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Input
                label={`${t('create.amount')}, ${fmtBankCurrencySuffix(account?.currencyCode)}`}
                required
                type="text"
                inputMode="decimal"
                {...register('amount', {
                  onChange: (e: ChangeEvent<HTMLInputElement>) => onAmountChange(e.target.value),
                })}
                placeholder="0,00"
                errorMessage={errors.amount?.message}
                className="h-8 text-[13px] tabular-nums text-right"
              />
              <Controller
                control={control}
                name="operationDate"
                render={({ field }) => (
                  <DatePickerInput
                    label={t('create.date')}
                    required
                    value={asText(field.value)}
                    onChange={field.onChange}
                    errorMessage={errors.operationDate?.message}
                  />
                )}
              />
            </div>

            <Input
              label={t('create.payerName')}
              {...register('payerName')}
              maxLength={200}
              hint={t(direction === 'OUT' ? 'create.payerNameHintOut' : 'create.payerNameHintIn')}
              className="h-8 text-[13px]"
            />

            <div className="grid grid-cols-2 gap-4">
              <Input
                label={t('create.payerIban')}
                {...register('payerIban')}
                maxLength={34}
                errorMessage={errors.payerIban?.message}
                className="h-8 text-[13px]"
              />
              <Input
                label={t('create.payerEdrpou')}
                {...register('payerEdrpou')}
                maxLength={12}
                inputMode="numeric"
                errorMessage={errors.payerEdrpou?.message}
                className="h-8 text-[13px] tabular-nums"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor={purposeId}
                className="text-[13px] font-medium text-foreground leading-none"
              >
                {t('create.purpose')}
              </label>
              <textarea
                id={purposeId}
                {...register('purpose')}
                maxLength={BANK_TX_REASON_MAX_LENGTH}
                rows={3}
                className="w-full rounded border border-border bg-surface px-3 py-2 text-[13px] text-foreground outline-none transition-all duration-150 hover:border-border-hover focus:border-primary focus:ring-3 focus:ring-brand-100 resize-y"
              />
              <div className="flex justify-between gap-3 text-[12px] leading-tight">
                <span className="text-destructive">{errors.purpose?.message}</span>
                <span className="text-muted-foreground tabular-nums">
                  {purpose.length} / {BANK_TX_REASON_MAX_LENGTH}
                </span>
              </div>
            </div>

            {/* ── Рознести як (BR-BANK-041) ─────────────────────── */}
            <div className="space-y-4 border-t border-border pt-4">
              <Select
                label={t('create.allocation.label')}
                value={allocType}
                onChange={e => changeAllocType(e.target.value as BankTxAllocationTypeValue | '')}
                disabled={!account}
                hint={
                  !account
                    ? t('create.allocation.pickAccountFirst')
                    : allocType === 'SUPPLIER_PAYMENT'
                      ? t('create.allocation.supplierNewHint')
                      : undefined
                }
                className="h-8 text-[13px]"
              >
                <option value="">{t('create.allocation.none')}</option>
                {allowedTypes(direction).map(mt => (
                  <option key={mt} value={mt}>
                    {bankTxMatchTypeLabel(mt)}
                  </option>
                ))}
              </Select>

              {allocKind === 'in' && (
                <IncomingAllocationFields
                  value={incoming}
                  onChange={next => {
                    setIncoming(next);
                    setIncomingErrors({});
                  }}
                  showType={false}
                  counterpartyError={incomingErrors.counterpartyId}
                  invoiceError={incomingErrors.invoiceId}
                  pickerOpenRef={pickerOpenRef}
                />
              )}

              {allocKind === 'out' && (
                <OutgoingAllocationFields
                  form={outForm}
                  enabled={open}
                  bankAccountId={account?.id}
                  currencyId={account?.currencyId}
                  currencyCode={account?.currencyCode}
                  labels={outLabels}
                  onLabelsChange={setOutLabels}
                  supplierMode="new"
                  pickerOpenRef={pickerOpenRef}
                />
              )}
            </div>
          </>
        )}
      </div>
      <DirtyConfirmDialog {...dirty.dialogProps} />
    </Modal>
  );
}
