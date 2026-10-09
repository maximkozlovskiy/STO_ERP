'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Landmark, Plus, Ban } from 'lucide-react';
import { fmtMoney, fmtDate, fmtBankCurrencySuffix } from '@/lib/format';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Pagination } from '@/components/ui/pagination';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { bankTxStatusLabel } from '@/i18n/enumLabel';
import { EMPTY_ITEMS } from '@/hooks/api/usePaginatedList';
import {
  useBankTransactions,
  useIgnoreBankTransaction,
  type BankTransaction,
  type BankTxDirection,
  type BankTxStatus,
} from '@/hooks/api/useBankStatements';
import { MatchBankTransactionModal } from '@/components/ui/MatchBankTransactionModal';
import { BankStatementImportModal } from '@/components/ui/BankStatementImportModal';
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

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const { data, isLoading, error } = useBankTransactions({
    status: status || undefined,
    direction,
    q: debouncedSearch.trim() || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    limit,
  });
  const ignoreMut = useIgnoreBankTransaction();
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

  // Фрагмент, а не власний контейнер: рядки стають прямими дітьми `.page-fill` сторінки й
  // отримують її рівний відступ 8px — як на «Купівлі». Раніше вкладений `.page-fill` із
  // окремою смугою під одну кнопку давав порожнє місце між вкладками й фільтрами.
  return (
    <>
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error instanceof Error ? error.message : t('page.error.load')}
        </div>
      )}

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
                <TableHead>{t('page.columns.payer')}</TableHead>
                <TableHead>{t('page.columns.account')}</TableHead>
                <TableHead>{t('page.columns.purpose')}</TableHead>
                <TableHead className="text-right">{t('page.columns.amount')}</TableHead>
                <TableHead>{t('page.columns.status')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="py-12 text-center">
                    <div className="flex justify-center">
                      <Spinner size="md" />
                    </div>
                  </TableCell>
                </TableRow>
              )}

              {!isLoading && items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="p-0">
                    <EmptyState
                      icon={Landmark}
                      // «Вихідні»: імпорт поки кладе лише вхідні (BR-BANK-001) — заклик
                      // «імпортуйте виписку» тут обіцяв би те, чого не станеться.
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
                    <TableCell className="text-[13px] max-w-55 truncate">
                      {tx.payerName ?? '—'}
                    </TableCell>
                    <TableCell className="text-[13px] text-muted-foreground whitespace-nowrap">
                      {tx.bankAccountName ??
                        (tx.bankAccountIban ? shortIban(tx.bankAccountIban) : '—')}
                    </TableCell>
                    <TableCell className="text-[13px] text-muted-foreground max-w-80 truncate">
                      {tx.purpose ?? '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-semibold text-[13px] whitespace-nowrap">
                      {fmtMoney(tx.amount)} {fmtBankCurrencySuffix(tx.bankAccountCurrencyCode)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_BADGE[tx.status] ?? 'secondary'}>
                        {bankTxStatusLabel(tx.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {tx.status === 'UNMATCHED' && (
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setMatchTx(tx)}
                          >
                            {t('page.row.match')}
                          </Button>
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
    </>
  );
}
