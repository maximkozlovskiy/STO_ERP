'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BANK_TX_REASON_MAX_LENGTH, bankTransactionUnreconcileFormSchema } from '@sto/shared';
import { toast } from '@/lib/toast';
import { fmtMoney, fmtDate, fmtBankCurrencySuffix } from '@/lib/format';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { bankTxMatchTypeLabel } from '@/i18n/enumLabel';
import { useUnreconcileBankTransaction, type BankTransaction } from '@/hooks/api/useBankStatements';

interface Props {
  open: boolean;
  onClose: () => void;
  transaction: BankTransaction | null;
  onDone?: () => void;
}

/**
 * Скасування рознесення (BR-BANK-039): причина обов'язкова, наслідок залежить від виду —
 * його показуємо ДО відправки, бо для повернення клієнту й зняття готівки це зворотний запис.
 */
export function UnreconcileBankTransactionModal({ open, onClose, transaction, onDone }: Props) {
  const { t } = useTranslation('bankStatements');
  const mut = useUnreconcileBankTransaction();
  const reasonId = useId();

  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  // `mut.isPending` is a render-time snapshot: two clicks inside one frame both see `false`.
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setReason('');
    setError('');
    submittingRef.current = false;
  }, [open, transaction?.id]);

  // Та сама схема, що й на бекенді: пробіли — не причина.
  const parsed = bankTransactionUnreconcileFormSchema.safeParse({ reason });
  const canSubmit = parsed.success && !mut.isPending;

  const handleSubmit = async () => {
    if (!transaction || !parsed.success || mut.isPending || submittingRef.current) return;
    submittingRef.current = true;
    setError('');
    try {
      await mut.mutateAsync({ id: transaction.id, reason: parsed.data.reason });
      toast.success(t('unreconcile.success'));
      onDone?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('unreconcile.error'));
    } finally {
      submittingRef.current = false;
    }
  };

  const close = () => {
    if (!mut.isPending) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      onSubmit={() => void handleSubmit()}
      title={t('unreconcile.title')}
      size="md"
      footer={
        <div className="flex gap-2 items-center justify-end w-full">
          <Button variant="outline" size="sm" onClick={close} disabled={mut.isPending}>
            {t('unreconcile.cancel')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void handleSubmit()}
            loading={mut.isPending}
            disabled={!canSubmit}
          >
            {t('unreconcile.submit')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {transaction && (
          <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-[13px]">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">
                {fmtDate(transaction.operationDate)}
                {transaction.payerName ? ` · ${transaction.payerName}` : ''}
              </span>
              <span className="font-semibold tabular-nums whitespace-nowrap">
                {fmtMoney(transaction.amount)}{' '}
                {fmtBankCurrencySuffix(transaction.bankAccountCurrencyCode)}
              </span>
            </div>
            <div className="mt-1 text-muted-foreground">
              {t('unreconcile.matchedAs')}: {bankTxMatchTypeLabel(transaction.matchedType)}
            </div>
          </div>
        )}

        {transaction?.matchedType && (
          <div
            role="note"
            className="text-[13px] text-warning bg-warning-subtle border border-warning/30 rounded-lg px-3 py-2"
          >
            {t(`unreconcile.consequence.${transaction.matchedType}`, { defaultValue: '' })}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2"
          >
            {error}
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label
            htmlFor={reasonId}
            className="text-[13px] font-medium text-foreground leading-none"
          >
            {t('unreconcile.reason')}
            <span className="ml-0.5 text-destructive">*</span>
          </label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={e => setReason(e.target.value)}
            maxLength={BANK_TX_REASON_MAX_LENGTH}
            rows={3}
            required
            autoFocus
            placeholder={t('unreconcile.reasonPlaceholder')}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-[13px] text-foreground outline-none transition-all duration-150 hover:border-border-hover focus:border-primary focus:ring-3 focus:ring-brand-100 resize-y"
          />
          <p className="text-[12px] text-muted-foreground text-right tabular-nums">
            {t('unreconcile.counter', { count: reason.length, max: BANK_TX_REASON_MAX_LENGTH })}
          </p>
        </div>
      </div>
    </Modal>
  );
}
