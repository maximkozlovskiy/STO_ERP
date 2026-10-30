'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isBankTxInAllocationType } from '@sto/shared';
import { toast } from '@/lib/toast';
import { fmtMoney, fmtDate, fmtBankCurrencySuffix } from '@/lib/format';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import {
  IncomingAllocationFields,
  emptyIncomingAllocation,
  type IncomingAllocationValue,
} from '@/components/ui/IncomingAllocationFields';
import {
  useMatchBankTransaction,
  useReconcileBankTransaction,
  type BankTransaction,
  type BankTxMatchType,
} from '@/hooks/api/useBankStatements';

interface Props {
  open: boolean;
  onClose: () => void;
  transaction: BankTransaction | null;
  /** Підказка авто-матчу — контрагент + тип для prefill (з рядка прев'ю). */
  suggestedCounterpartyId?: string | null;
  suggestedCounterpartyName?: string | null;
  suggestedMatchType?: BankTxMatchType | null;
  onMatched?: () => void;
}

export function MatchBankTransactionModal({
  open,
  onClose,
  transaction,
  suggestedCounterpartyId,
  suggestedCounterpartyName,
  suggestedMatchType,
  onMatched,
}: Props) {
  const { t } = useTranslation('bankStatements');
  const matchMut = useMatchBankTransaction();
  // «Повернення від постачальника» — не оплата клієнта: проводка через `reconcile` (BR-BANK-046).
  const reconcileMut = useReconcileBankTransaction();
  const pending = matchMut.isPending || reconcileMut.isPending;

  const [value, setValue] = useState<IncomingAllocationValue>(emptyIncomingAllocation);
  const [error, setError] = useState('');

  // Prefill з підказки авто-матчу — раз на кожне відкриття.
  useEffect(() => {
    if (!open) return;
    setError('');
    setValue(
      emptyIncomingAllocation(
        suggestedMatchType && isBankTxInAllocationType(suggestedMatchType)
          ? suggestedMatchType
          : 'PREPAYMENT',
        suggestedCounterpartyId ?? '',
        suggestedCounterpartyName ?? '',
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, transaction?.id]);

  const { counterpartyId, type, invoiceId } = value;

  const handleSubmit = useCallback(async () => {
    if (!transaction) return;
    if (!counterpartyId) {
      setError(t('match.pickCounterparty'));
      return;
    }
    if (type === 'INVOICE' && !invoiceId) {
      setError(t('match.invoiceRequired'));
      return;
    }
    setError('');
    try {
      if (type === 'SUPPLIER_REFUND_IN') {
        await reconcileMut.mutateAsync({ id: transaction.id, data: { type, counterpartyId } });
      } else {
        await matchMut.mutateAsync({
          id: transaction.id,
          data: {
            counterpartyId,
            type,
            invoiceId: type === 'INVOICE' ? invoiceId : undefined,
          },
        });
      }
      toast.success(t('match.success'));
      onMatched?.();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('match.error');
      setError(msg);
      toast.error(msg);
    }
  }, [transaction, counterpartyId, type, invoiceId, matchMut, reconcileMut, t, onMatched, onClose]);

  // Стабільний onClose: картка не перестворює обробник на кожен рендер.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback(() => onCloseRef.current(), []);

  return (
    <Modal
      open={open}
      onClose={close}
      onSubmit={() => void handleSubmit()}
      title={t('match.title')}
      size="md"
      footer={
        <div className="flex gap-2 items-center justify-end w-full">
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
            {t('match.cancel')}
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            loading={pending}
            disabled={pending || !counterpartyId}
            size="sm"
          >
            {t('match.submit')}
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
              <span className="font-semibold tabular-nums">
                {fmtMoney(transaction.amount)}{' '}
                {fmtBankCurrencySuffix(transaction.bankAccountCurrencyCode)}
              </span>
            </div>
            {transaction.purpose && (
              <div className="mt-1 text-muted-foreground truncate">{transaction.purpose}</div>
            )}
          </div>
        )}

        {error && (
          <div className="text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <IncomingAllocationFields value={value} onChange={setValue} />
      </div>
    </Modal>
  );
}
