'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { toast } from '@/lib/toast';
import { fmtMoney, fmtDate, fmtBankCurrencySuffix } from '@/lib/format';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import {
  EMPTY_OUTGOING_LABELS,
  OUTGOING_LINK_FIELDS,
  OutgoingAllocationFields,
  buildOutgoingPayload,
  emptyOutgoingAllocation,
  type OutgoingAllocationLabels,
  type SupplierMode,
} from '@/components/ui/OutgoingAllocationFields';
import { bankTxMatchTypeLabel } from '@/i18n/enumLabel';
import {
  useReconcileBankTransaction,
  useSupplierPaymentCandidates,
  type BankTransaction,
  type ReconcileTransactionInput,
} from '@/hooks/api/useBankStatements';

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

  const form = useForm<
    BankTransactionReconcileFormValues,
    unknown,
    BankTransactionReconcilePayload
  >({
    resolver: i18nZodResolver(bankTransactionReconcileFormSchema),
    defaultValues: emptyOutgoingAllocation(initialType),
  });
  const {
    control,
    reset,
    setValue,
    clearErrors,
    handleSubmit,
    formState: { errors },
  } = form;

  const [supplierMode, setSupplierMode] = useState<SupplierMode>('existing');
  const [labels, setLabels] = useState<OutgoingAllocationLabels>(EMPTY_OUTGOING_LABELS);
  const [error, setError] = useState('');
  // Крок підтвердження: payload уже зібрано й перевірено, чекає на «Підтвердити».
  const [pending, setPending] = useState<ReconcileTransactionInput | null>(null);
  // Автоперемикання на «Створити нову» — раз на відкриття: інакше користувач не зміг би
  // повернутись на «наявну» і побачити пояснення, чому список порожній.
  const autoSwitchedRef = useRef(false);
  const submittingRef = useRef(false);

  const txId = transaction?.id;
  const type = form.watch('type');

  const candidatesQuery = useSupplierPaymentCandidates(txId, open && type === 'SUPPLIER_PAYMENT');
  const candidates = candidatesQuery.data;

  const clearLinks = () => {
    for (const f of OUTGOING_LINK_FIELDS) setValue(f, '');
    setLabels(EMPTY_OUTGOING_LABELS);
    clearErrors();
    setError('');
  };

  useEffect(() => {
    if (!open) return;
    reset(emptyOutgoingAllocation(initialType));
    setSupplierMode('existing');
    setLabels(EMPTY_OUTGOING_LABELS);
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
    const data = buildOutgoingPayload(values, supplierMode);
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
    pending?.type === 'CASH_WITHDRAWAL' ? labels.cashRegisterName : labels.counterpartyName;

  return (
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
              <Button variant="outline" size="sm" onClick={() => setPending(null)} disabled={busy}>
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

            <OutgoingAllocationFields
              form={form}
              enabled={open}
              bankAccountId={transaction?.bankAccountId}
              currencyId={transaction?.currencyId}
              currencyCode={transaction?.bankAccountCurrencyCode}
              labels={labels}
              onLabelsChange={setLabels}
              supplierMode={supplierMode}
              onSupplierModeChange={changeSupplierMode}
              candidatesQuery={candidatesQuery}
            />
          </>
        )}
      </div>
    </Modal>
  );
}
