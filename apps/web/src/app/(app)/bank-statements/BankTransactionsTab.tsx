'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Landmark, Plus, Ban, ArrowLeftRight, Trash2 } from 'lucide-react';
import { BANK_TX_OUT_MATCH_TYPE_VALUES, type BankTxOutMatchTypeValue } from '@sto/shared';
import { fmtMoney, fmtDate, fmtBankCurrencySuffix } from '@/lib/format';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Pagination } from '@/components/ui/pagination';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { ListLoadError } from '@/components/ui/list-load-error';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { bankTxStatusLabel, bankTxMatchTypeLabel, bankTxSourceLabel } from '@/i18n/enumLabel';
import { EMPTY_ITEMS } from '@/hooks/api/usePaginatedList';
import {
  useBankTransactions,
  useIgnoreBankTransaction,
  useDeleteBankTransaction,
  type BankTransaction,
  type BankTxDirection,
  type BankTxStatus,
} from '@/hooks/api/useBankStatements';
import { MatchBankTransactionModal } from '@/components/ui/MatchBankTransactionModal';
import { BankStatementImportModal } from '@/components/ui/BankStatementImportModal';
import { MatchOutgoingBankTransactionModal } from '@/components/ui/MatchOutgoingBankTransactionModal';
import { UnreconcileBankTransactionModal } from '@/components/ui/UnreconcileBankTransactionModal';
import { BankTransactionCreateModal } from '@/components/ui/BankTransactionCreateModal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { DateRangeFilter } from '@/components/ui/date-range-filter';
import { ListSearchInput } from '@/components/ui/list-search-input';
import { useDebounce } from '@/hooks/useDebounce';

const STATUS_OPTIONS: BankTxStatus[] = ['UNMATCHED', 'MATCHED', 'IGNORED'];

const STATUS_BADGE: Record<string, BadgeVariant> = {
  UNMATCHED: 'warning',
  MATCHED: 'success',
  IGNORED: 'secondary',
};

/** Скорочений IBAN для колонки «Рахунок» коли немає назви рахунку (останні 4 символи). */
function shortIban(iban: string): string {
  return iban.length > 8 ? `…${iban.slice(-4)}` : iban;
}

const TRANSFER_ONLY: readonly BankTxOutMatchTypeValue[] = ['TRANSFER'];
const COLUMN_COUNT = 8;

/**
 * Зняти рознесення можна лише з рядка, рознесеного через `reconcile` (BR-BANK-039): вид — із
 * «вихідних» і немає `paymentId`. Вхідний, рознесений через `match`, має платіж клієнта, а його
 * сторно в системі немає (BR-BANK-040) — кнопка там обіцяла б відмову.
 */
function canUnreconcile(tx: BankTransaction): boolean {
  return (
    tx.status === 'MATCHED' &&
    !tx.paymentId &&
    !!tx.matchedType &&
    (BANK_TX_OUT_MATCH_TYPE_VALUES as readonly string[]).includes(tx.matchedType)
  );
}

/** Сума зі знаком і валютою рахунку: «+» надходження, «−» списання (у базі сума завжди > 0). */
function signedAmount(tx: BankTransaction): string {
  const sign = tx.direction === 'OUT' ? '−' : '+';
  return `${sign}${fmtMoney(tx.amount)} ${fmtBankCurrencySuffix(tx.bankAccountCurrencyCode)}`;
}

export default function BankTransactionsTab({ direction }: { direction?: BankTxDirection }) {
  const { t } = useTranslation('bankStatements');

  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;
  const [importOpen, setImportOpen] = useState(false);
  const [matchTx, setMatchTx] = useState<BankTransaction | null>(null);
  // Ігнорування з причиною — власна модалка (не window.prompt: стилізована, тестована, offline-safe).
  const [ignoreTx, setIgnoreTx] = useState<BankTransaction | null>(null);
  const [ignoreReason, setIgnoreReason] = useState('');
  // Рознесення через `reconcile`: вихідний рядок — усі види, вхідний — лише переказ.
  const [reconcile, setReconcile] = useState<{
    tx: BankTransaction;
    allowedTypes?: readonly BankTxOutMatchTypeValue[];
  } | null>(null);
  const [unreconcileTx, setUnreconcileTx] = useState<BankTransaction | null>(null);
  const [deleteTx, setDeleteTx] = useState<BankTransaction | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const { data, isLoading, error, refetch } = useBankTransactions({
    status: status || undefined,
    direction,
    q: debouncedSearch.trim() || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    limit,
  });
  const ignoreMut = useIgnoreBankTransaction();
  const deleteMut = useDeleteBankTransaction();
  const isFiltered = !!(debouncedSearch.trim() || dateFrom || dateTo || status);
  const emptyKind = isFiltered ? 'emptyFiltered' : direction === 'OUT' ? 'emptyOutgoing' : 'empty';

  const items = data?.items ?? (EMPTY_ITEMS as unknown as BankTransaction[]);
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const resetPageAnd = (fn: () => void) => {
    fn();
    setPage(1);
  };

  const openIgnore = (tx: BankTransaction) => {
    setIgnoreReason('');
    setIgnoreTx(tx);
  };

  const submitIgnore = async () => {
    if (!ignoreTx) return;
    const reason = ignoreReason.trim();
    if (!reason) {
      toast.error(t('ignore.reasonRequired'));
      return;
    }
    try {
      await ignoreMut.mutateAsync({ id: ignoreTx.id, reason });
      toast.success(t('ignore.success'));
      setIgnoreTx(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('ignore.error'));
    }
  };

  const submitDelete = async () => {
    if (!deleteTx || deleteMut.isPending) return;
    const id = deleteTx.id;
    setDeleteTx(null);
    try {
      await deleteMut.mutateAsync(id);
      toast.success(t('page.delete.success'));
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t('page.delete.error'));
    }
  };

  /** Деталь рознесення: з чим саме пов'язано рядок (поля приходять лише для свого виду). */
  const matchedDetail = (tx: BankTransaction): string =>
    [
      tx.counterpartyName,
      tx.supplierPaymentNumber
        ? t('page.row.supplierPayment', { number: tx.supplierPaymentNumber })
        : null,
      tx.expenseCategoryName,
      tx.payrollPeriodStart && tx.payrollPeriodEnd
        ? `${fmtDate(tx.payrollPeriodStart)} – ${fmtDate(tx.payrollPeriodEnd)}`
        : null,
      tx.employeeName,
      tx.transferBankAccountName,
    ]
      .filter(Boolean)
      .join(' · ');

  // Фрагмент, а не власний контейнер: рядки стають прямими дітьми `.page-fill` сторінки й
  // отримують її рівний відступ 8px — як на «Купівлі». Раніше вкладений `.page-fill` із
  // окремою смугою під одну кнопку давав порожнє місце між вкладками й фільтрами.
  return (
    <>
      <ListLoadError error={error} onRetry={() => void refetch()} />

      {/* Status filter pills */}
      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
        <StatusPill
          value=""
          label={t('page.pills.all')}
          active={status === ''}
          onSelect={() => resetPageAnd(() => setStatus(''))}
        />
        {STATUS_OPTIONS.map(s => (
          <StatusPill
            key={s}
            value={s}
            label={bankTxStatusLabel(s)}
            active={status === s}
            onSelect={v => resetPageAnd(() => setStatus(v))}
          />
        ))}
      </div>

      {/* Пошук · З · По + дія сторінки праворуч. Дати за замовчуванням порожні: виписку
          імпортують за минулі дні, і нерознесені рядки мають бути на виду без вибору періоду. */}
      <div className="flex flex-wrap items-center gap-3 shrink-0">
        <ListSearchInput
          value={search}
          onChange={v => resetPageAnd(() => setSearch(v))}
          label={t('page.filters.searchPlaceholder')}
        />
        <DateRangeFilter
          from={dateFrom}
          to={dateTo}
          onFromChange={v => resetPageAnd(() => setDateFrom(v))}
          onToChange={v => resetPageAnd(() => setDateTo(v))}
          fromLabel={t('page.filters.dateFrom')}
          toLabel={t('page.filters.dateTo')}
        />
        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="outline"
            onClick={() => setCreateOpen(true)}
            leftIcon={<Plus className="h-4 w-4" />}
          >
            {t('page.newPayment')}
          </Button>
          <Button onClick={() => setImportOpen(true)} leftIcon={<Plus className="h-4 w-4" />}>
            {t('page.import')}
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="flex flex-1 min-h-0">
        <div className="table-scroll-container flex-1 min-h-0 min-w-0 overflow-auto bg-surface border border-border rounded-xl">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('page.columns.date')}</TableHead>
                <TableHead>{t('page.columns.counterparty')}</TableHead>
                <TableHead>{t('page.columns.account')}</TableHead>
                <TableHead>{t('page.columns.purpose')}</TableHead>
                <TableHead className="text-right">{t('page.columns.amount')}</TableHead>
                <TableHead>{t('page.columns.status')}</TableHead>
                <TableHead>{t('page.columns.matchedAs')}</TableHead>
                {/* Sticky: at 1280 the table is wider than its container, and the row actions
                    («Рознести», «Зняти рознесення») would sit off-screen behind a sideways scroll. */}
                <TableHead className="sticky right-0 bg-secondary">
                  <span className="sr-only">{t('page.columns.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={COLUMN_COUNT} className="py-12 text-center">
                    <div className="flex justify-center">
                      <Spinner size="md" />
                    </div>
                  </TableCell>
                </TableRow>
              )}

              {!isLoading && !error && items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={COLUMN_COUNT} className="p-0">
                    <EmptyState
                      icon={Landmark}
                      // Діє пошук, період чи статус → «нічого не знайдено»: заклик імпортувати
                      // виписку тут брехав би, коли рядки є, але поза відбором.
                      title={t(`page.${emptyKind}.title`)}
                      description={t(`page.${emptyKind}.description`)}
                    />
                  </TableCell>
                </TableRow>
              )}

              {!isLoading &&
                items.map(tx => (
                  <TableRow key={tx.id} className="group transition-colors">
                    <TableCell className="tabular-nums text-[13px] text-muted-foreground whitespace-nowrap">
                      {fmtDate(tx.operationDate)}
                    </TableCell>
                    {/* payerName — контрагент операції: платник для вхідного, отримувач для
                        вихідного (BR-BANK-020). */}
                    <TableCell className="text-[13px] max-w-44">
                      <div className="truncate">{tx.payerName ?? '—'}</div>
                      {tx.source === 'MANUAL' && (
                        <div className="text-[11px] text-muted-foreground">
                          {bankTxSourceLabel(tx.source)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-[13px] text-muted-foreground whitespace-nowrap">
                      {tx.bankAccountName ??
                        (tx.bankAccountIban ? shortIban(tx.bankAccountIban) : '—')}
                    </TableCell>
                    <TableCell className="text-[13px] text-muted-foreground max-w-56 truncate">
                      {tx.purpose ?? '—'}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right tabular-nums font-semibold text-[13px] whitespace-nowrap',
                        tx.direction === 'OUT' ? 'text-destructive' : 'text-success',
                      )}
                    >
                      {signedAmount(tx)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_BADGE[tx.status] ?? 'secondary'}>
                        {bankTxStatusLabel(tx.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-[13px] max-w-52">
                      {tx.status === 'MATCHED' && tx.matchedType && (
                        <>
                          <div className="truncate">{bankTxMatchTypeLabel(tx.matchedType)}</div>
                          {matchedDetail(tx) && (
                            <div
                              className="text-[12px] text-muted-foreground truncate"
                              title={matchedDetail(tx)}
                            >
                              {matchedDetail(tx)}
                            </div>
                          )}
                        </>
                      )}
                      {tx.status === 'UNMATCHED' && tx.unmatchReason && (
                        <div
                          className="text-[12px] text-muted-foreground truncate"
                          title={
                            tx.unmatchedAt
                              ? t('page.row.unmatchCancelledAt', { date: fmtDate(tx.unmatchedAt) })
                              : undefined
                          }
                        >
                          {t('page.row.unmatchCancelled', { reason: tx.unmatchReason })}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="sticky right-0 bg-surface group-hover:bg-secondary text-right whitespace-nowrap">
                      {canUnreconcile(tx) && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setUnreconcileTx(tx)}
                        >
                          {t('page.row.unreconcile')}
                        </Button>
                      )}
                      {tx.status === 'UNMATCHED' && (
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              tx.direction === 'OUT' ? setReconcile({ tx }) : setMatchTx(tx)
                            }
                          >
                            {t('page.row.match')}
                          </Button>
                          {tx.direction === 'IN' && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              title={t('page.row.transfer')}
                              aria-label={t('page.row.transfer')}
                              className="text-muted-foreground hover:text-foreground"
                              onClick={() => setReconcile({ tx, allowedTypes: TRANSFER_ONLY })}
                            >
                              <ArrowLeftRight className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            title={t('page.row.ignore')}
                            aria-label={t('page.row.ignore')}
                            className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            onClick={() => openIgnore(tx)}
                          >
                            <Ban className="h-3.5 w-3.5" />
                          </Button>
                          {/* Видалити можна лише внесений вручну нерознесений рядок (BR-BANK-024). */}
                          {tx.source === 'MANUAL' && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              title={t('page.row.delete')}
                              aria-label={t('page.row.delete')}
                              className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                              onClick={() => setDeleteTx(tx)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      <MatchBankTransactionModal
        open={!!matchTx}
        onClose={() => setMatchTx(null)}
        transaction={matchTx}
        suggestedCounterpartyId={matchTx?.counterpartyId}
        onMatched={() => setMatchTx(null)}
      />

      <Modal
        open={!!ignoreTx}
        onClose={() => (ignoreMut.isPending ? undefined : setIgnoreTx(null))}
        title={t('ignore.title')}
        size="sm"
      >
        <div className="flex flex-col gap-3">
          <Input
            label={t('ignore.reason')}
            placeholder={t('ignore.reasonPlaceholder')}
            value={ignoreReason}
            onChange={e => setIgnoreReason(e.target.value)}
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter') void submitIgnore();
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setIgnoreTx(null)}
              disabled={ignoreMut.isPending}
            >
              {t('ignore.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void submitIgnore()}
              loading={ignoreMut.isPending}
              disabled={!ignoreReason.trim()}
            >
              {t('ignore.submit')}
            </Button>
          </div>
        </div>
      </Modal>

      <BankStatementImportModal open={importOpen} onClose={() => setImportOpen(false)} />

      <MatchOutgoingBankTransactionModal
        open={!!reconcile}
        onClose={() => setReconcile(null)}
        transaction={reconcile?.tx ?? null}
        allowedTypes={reconcile?.allowedTypes}
      />

      <UnreconcileBankTransactionModal
        open={!!unreconcileTx}
        onClose={() => setUnreconcileTx(null)}
        transaction={unreconcileTx}
      />

      {/* Напрям за замовчуванням — напрям вкладки; на «Всі» — вхідний. */}
      <BankTransactionCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        defaultDirection={direction ?? 'IN'}
      />

      <ConfirmDialog
        open={!!deleteTx}
        title={t('page.delete.title')}
        message={
          deleteTx
            ? t('page.delete.message', {
                date: fmtDate(deleteTx.operationDate),
                amount: signedAmount(deleteTx),
              })
            : undefined
        }
        confirmLabel={t('page.delete.confirm')}
        cancelLabel={t('ignore.cancel')}
        variant="destructive"
        onConfirm={() => void submitDelete()}
        onCancel={() => setDeleteTx(null)}
      />
    </>
  );
}
