'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { displayCounterpartyName } from '@/lib/utils';
import { fmtMoney, fmtDate } from '@/lib/format';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal } from '@/components/ui/search-picker-modal';
import { bankTxMatchTypeLabel } from '@/i18n/enumLabel';
import {
  useMatchBankTransaction,
  type BankTransaction,
  type BankTxMatchType,
} from '@/hooks/api/useBankStatements';

const MATCH_TYPES: BankTxMatchType[] = ['PREPAYMENT', 'SERVICE', 'INVOICE', 'REFUND', 'OTHER'];

interface CounterpartyRef {
  id: string;
  companyName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

interface InvoiceRef {
  id: string;
  number: string;
  amount: number;
}

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

  const [counterpartyId, setCounterpartyId] = useState('');
  const [counterpartyName, setCounterpartyName] = useState('');
  const [type, setType] = useState<BankTxMatchType>('PREPAYMENT');
  const [invoiceId, setInvoiceId] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [error, setError] = useState('');
  const [cpPickerOpen, setCpPickerOpen] = useState(false);
  const [invoicePickerOpen, setInvoicePickerOpen] = useState(false);

  // Prefill з підказки авто-матчу — раз на кожне відкриття.
  useEffect(() => {
    if (!open) return;
    setError('');
    setCounterpartyId(suggestedCounterpartyId ?? '');
    setCounterpartyName(suggestedCounterpartyName ?? '');
    setType(suggestedMatchType ?? 'PREPAYMENT');
    setInvoiceId('');
    setInvoiceNumber('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, transaction?.id]);

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
      await matchMut.mutateAsync({
        id: transaction.id,
        data: {
          counterpartyId,
          type,
          invoiceId: type === 'INVOICE' ? invoiceId : undefined,
        },
      });
      toast.success(t('match.success'));
      onMatched?.();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('match.error');
      setError(msg);
      toast.error(msg);
    }
  }, [transaction, counterpartyId, type, invoiceId, matchMut, t, onMatched, onClose]);

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        onSubmit={handleSubmit}
        title={t('match.title')}
        size="md"
        footer={
          <div className="flex gap-2 items-center justify-end w-full">
            <Button variant="outline" size="sm" onClick={onClose} disabled={matchMut.isPending}>
              {t('match.cancel')}
            </Button>
            <Button
              onClick={handleSubmit}
              loading={matchMut.isPending}
              disabled={matchMut.isPending || !counterpartyId}
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
                <span className="font-semibold tabular-nums">{fmtMoney(transaction.amount)} ₴</span>
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

          {/* Контрагент */}
          <EntityPickerField
            label={t('match.counterparty')}
            required
            display={counterpartyName}
            placeholder={t('match.counterpartyPlaceholder')}
            className="h-8 text-[13px]"
            onPick={() => setCpPickerOpen(true)}
            onClear={() => {
              setCounterpartyId('');
              setCounterpartyName('');
            }}
          />

          {/* Тип операції */}
          <Select
            label={t('match.type')}
            required
            value={type}
            onChange={e => {
              const next = e.target.value as BankTxMatchType;
              setType(next);
              if (next !== 'INVOICE') {
                setInvoiceId('');
                setInvoiceNumber('');
              }
            }}
            className="h-8 text-[13px]"
          >
            {MATCH_TYPES.map(mt => (
              <option key={mt} value={mt}>
                {bankTxMatchTypeLabel(mt)}
              </option>
            ))}
          </Select>

          {/* Рахунок (лише для INVOICE) */}
          {type === 'INVOICE' && (
            <EntityPickerField
              label={t('match.invoice')}
              required
              display={invoiceNumber}
              placeholder={t('match.invoicePlaceholder')}
              className="h-8 text-[13px]"
              disabled={!counterpartyId}
              onPick={() => setInvoicePickerOpen(true)}
              onClear={() => {
                setInvoiceId('');
                setInvoiceNumber('');
              }}
            />
          )}
        </div>
      </Modal>

      {/* Counterparty picker */}
      <SearchPickerModal
        open={cpPickerOpen}
        onClose={() => setCpPickerOpen(false)}
        selectedId={counterpartyId || null}
        onSelect={(item: { id: string; primary: string }) => {
          setCounterpartyId(item.id);
          setCounterpartyName(item.primary);
          // зміна контрагента скидає прив'язку до рахунку (рахунок належить контрагенту)
          setInvoiceId('');
          setInvoiceNumber('');
          setCpPickerOpen(false);
        }}
        title={t('match.pickCounterparty')}
        fetchItems={q =>
          apiFetch<{ items: CounterpartyRef[] }>(
            `/counterparties?q=${encodeURIComponent(q)}&limit=30`,
          ).then(d => d.items.map(c => ({ id: c.id, primary: displayCounterpartyName(c) })))
        }
      />

      {/* Invoice picker (filtered by counterparty) */}
      <SearchPickerModal
        open={invoicePickerOpen}
        onClose={() => setInvoicePickerOpen(false)}
        selectedId={invoiceId || null}
        onSelect={(item: { id: string; primary: string }) => {
          setInvoiceId(item.id);
          setInvoiceNumber(item.primary);
          setInvoicePickerOpen(false);
        }}
        title={t('match.pickInvoice')}
        fetchItems={q =>
          apiFetch<{ items: InvoiceRef[] }>(
            `/invoices?q=${encodeURIComponent(q)}&counterpartyId=${counterpartyId}&limit=30`,
          ).then(d =>
            d.items.map(inv => ({
              id: inv.id,
              primary: inv.number,
              secondary: `${fmtMoney(inv.amount)} ₴`,
            })),
          )
        }
      />
    </>
  );
}
