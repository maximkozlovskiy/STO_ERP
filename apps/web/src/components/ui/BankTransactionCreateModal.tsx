'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm, Controller } from 'react-hook-form';
import {
  BANK_TX_DIRECTION_VALUES,
  BANK_TX_REASON_MAX_LENGTH,
  bankTransactionCreateFormSchema,
  type BankTransactionCreateFormValues,
  type BankTransactionCreatePayload,
} from '@sto/shared';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { kyivToday, fmtBankCurrencySuffix } from '@/lib/format';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { bankTxDirectionLabel } from '@/i18n/enumLabel';
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

/**
 * Ручне внесення банківського платежу (BR-BANK-023): рядок `MANUAL`, будь-якого напряму,
 * у валюті рахунку. Рознесення — окремою дією зі списку.
 */
export function BankTransactionCreateModal({ open, onClose, defaultDirection, onCreated }: Props) {
  const { t } = useTranslation('bankStatements');
  const createMut = useCreateBankTransaction();
  const accountsQuery = useBankAccountOptions(open);
  const accounts = accountsQuery.data;
  const purposeId = useId();

  const {
    control,
    register,
    reset,
    watch,
    setValue,
    handleSubmit,
    formState: { errors },
  } = useForm<BankTransactionCreateFormValues, unknown, BankTransactionCreatePayload>({
    resolver: i18nZodResolver(bankTransactionCreateFormSchema),
    defaultValues: emptyDefaults(defaultDirection ?? 'IN'),
    mode: 'onBlur',
  });

  const [error, setError] = useState('');
  // Один ключ на відкриття форми: повторний клік після обриву на відповіді не створить
  // другий платіж (BR-BANK-023). Нове відкриття — новий платіж, отже й новий ключ.
  const idempotencyKeyRef = useRef('');
  // Синхронний guard від подвійного кліку в одному tick-у (disabled ще не застосувався).
  const savingRef = useRef(false);
  const autoSelectedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    reset(emptyDefaults(defaultDirection ?? 'IN'));
    setError('');
    idempotencyKeyRef.current = newIdempotencyKey();
    savingRef.current = false;
    autoSelectedRef.current = false;
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

  const onValid = async (values: BankTransactionCreatePayload) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setError('');
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
    try {
      await createMut.mutateAsync({ data, idempotencyKey: idempotencyKeyRef.current });
      toast.success(t('create.success'));
      onCreated?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('create.error'));
    } finally {
      savingRef.current = false;
    }
  };

  const submit = handleSubmit(onValid);
  const close = () => {
    if (!createMut.isPending) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      onSubmit={() => void submit()}
      title={t('create.title')}
      size="lg"
      footer={
        <div className="flex gap-2 items-center justify-end w-full">
          <Button variant="outline" size="sm" onClick={close} disabled={createMut.isPending}>
            {t('create.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            loading={createMut.isPending}
            disabled={createMut.isPending}
          >
            {t('create.submit')}
          </Button>
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
                  onClick={() => setValue('direction', d, { shouldDirty: true })}
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
            {...register('amount')}
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
          hint={t(direction === 'OUT' ? 'create.payerNameHintOut' : 'create.payerNameHintIn')}
          className="h-8 text-[13px]"
        />

        <div className="grid grid-cols-2 gap-4">
          <Input
            label={t('create.payerIban')}
            {...register('payerIban')}
            errorMessage={errors.payerIban?.message}
            className="h-8 text-[13px]"
          />
          <Input
            label={t('create.payerEdrpou')}
            {...register('payerEdrpou')}
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
      </div>
    </Modal>
  );
}
