'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DoorOpen,
  DoorClosed,
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  RotateCw,
  Undo2,
  Wallet,
} from 'lucide-react';
import {
  FISCAL_STATUS_BADGE,
  FISCAL_STATUS_DESCRIPTIONS,
  RECEPTIONIST_CASH_REASONS,
  type CashDirectionValue,
} from '@sto/shared';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState, ListEmptyState } from '@/components/ui/empty-state';
import { ListLoadError } from '@/components/ui/list-load-error';
import { toast } from '@/lib/toast';
import { fmtMoney, fmtDateTime, kyivToday } from '@/lib/format';
import { DateRangeFilter } from '@/components/ui/date-range-filter';
import { ListSearchInput } from '@/components/ui/list-search-input';
import { useDebounce } from '@/hooks/useDebounce';
import { RowActionsMenu } from '@/components/ui/row-actions-menu';
import { cn } from '@/lib/utils';
import { useLinkedNav } from '@/lib/linked-nav';
import { fiscalStatusLabel } from '@/i18n/enumLabel';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { ListFiltersRow } from '@/components/ui/list-toolbar';
import { useCurrentShift, useOpenShift, useCloseShift } from '@/hooks/api/useCashShift';
import {
  useCashRegisters,
  useCashOperations,
  useRetryCashFiscal,
  useBaseCurrency,
  type CashOperation,
} from '@/hooks/api/useCash';
import { CashOperationModal } from './CashOperationModal';
import { CashReversalModal } from './CashReversalModal';

/**
 * Стеля історії на сервері (BR-CASH-015): більше рядків за один запит він не віддає, зсуву немає.
 * Просимо саме стільки; якщо прийшло рівно стільки — старіші операції не вмістились, і про це
 * треба сказати (Bug #849: без `limit` сервер давав 100 рядків, і список мовчки обрізався).
 */
export const CASH_HISTORY_LIMIT = 500;

/**
 * Рядки, створені іншим документом, скасовують там, де створили (BR-CASH-023): зарплату — у
 * відомості, банк — у виписці. Кнопка тут обіцяла б відмову сервера.
 */
const NOT_REVERSIBLE_HERE: ReadonlySet<string> = new Set(['PayrollPeriod', 'BankTransaction']);

/** Чи можна сторнувати рядок: ще не сторнований, сам не сторно, не з зарплати чи банку. */
export function isReversible(op: CashOperation): boolean {
  return !op.reversedBy && !op.reversalOfId && !NOT_REVERSIBLE_HERE.has(op.documentType ?? '');
}

/** id рядка історії в DOM — за ним позначка сторно прокручує до пари. */
const rowDomId = (operationId: string) => `cash-op-${operationId}`;

/** Скільки підсвічувати рядок, до якого перейшли з позначки сторно. */
const JUMP_HIGHLIGHT_MS = 2000;

interface Props {
  /**
   * Усі ручні операції й сторно — власник, адміністратор, бухгалтер (ролі POST …/operations і
   * POST …/operations/:operationId/reverse збігаються).
   */
  canOperate?: boolean;
  /** Приймальня: лише внесення з приводами `RECEPTIONIST_CASH_REASONS`, без видачі й статей. */
  receptionist?: boolean;
  /**
   * Чи може роль відкрити картку замовлення постачальнику (сторінка «Купівля» — власник і
   * адміністратор; бухгалтер бачить там лише графік оплат, приймальня — /403). Решті номер
   * замовлення-підстави показуємо текстом, а не посиланням у нікуди.
   */
  canOpenPurchaseOrders?: boolean;
}

export default function CashOperationsTab({
  canOperate = false,
  receptionist = false,
  canOpenPurchaseOrders = false,
}: Props) {
  const { t } = useTranslation('cash');
  const nav = useLinkedNav();
  const {
    data: registers,
    isLoading: regLoading,
    error: regError,
    refetch: refetchRegisters,
  } = useCashRegisters();
  const [selectedId, setSelectedId] = useState('');
  const selected = useMemo(
    () => registers?.find(r => r.id === selectedId) ?? null,
    [registers, selectedId],
  );

  // Автовибір першої каси.
  useEffect(() => {
    if (!selectedId && registers?.length) setSelectedId(registers[0].id);
  }, [registers, selectedId]);

  // Мультивалюта: символ валюти каси + чи показувати колонку «У базовій» (лише для НЕ-базової каси).
  // База конфігурована (OrganisationSettings.currency) — НЕ хардкодимо 'UAH'/'₴', інакше для org
  // з іншою базою колонка/символ були б хибними. Поки база не завантажилась — трактуємо касу як
  // базову (не мигаємо порожньою колонкою).
  const { data: baseCurrency } = useBaseCurrency();
  const baseCode = baseCurrency?.code ?? 'UAH';
  const baseSymbol = baseCurrency?.symbol ?? '₴';
  const curSymbol = selected?.currencySymbol ?? selected?.currencyCode ?? '';
  const isBaseCurrency = !baseCurrency || (selected?.currencyCode ?? baseCode) === baseCode;

  // Зміна є лише у фіскальної каси (BR-CASH-027): для нефіскальної віджета немає — не питаємо.
  const fiscalSelected = selected?.isFiscal ? selected : null;
  const {
    data: shift,
    isLoading: shiftLoading,
    isError: shiftError,
    refetch: refetchShift,
  } = useCurrentShift(fiscalSelected?.branchId ?? null, fiscalSelected?.id ?? null);
  const openShift = useOpenShift();
  const closeShift = useCloseShift();
  // Період за замовчуванням — сьогодні (київський день): касир дивиться поточну зміну, а не
  // всю історію каси.
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [dateFrom, setDateFrom] = useState(() => kyivToday());
  const [dateTo, setDateTo] = useState(() => kyivToday());
  const opsFilter = {
    q: debouncedSearch.trim() || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  };
  const hasOpsFilter = !!(opsFilter.q || opsFilter.dateFrom || opsFilter.dateTo);
  const {
    data: operations,
    isLoading: opsLoading,
    error: opsError,
    refetch: refetchOps,
  } = useCashOperations(selectedId || null, opsFilter, CASH_HISTORY_LIMIT);
  const historyTruncated = (operations?.length ?? 0) >= CASH_HISTORY_LIMIT;
  const [opOpen, setOpOpen] = useState(false);
  // Напрям лишається в стані й після закриття — щоб заголовок не мигав під час анімації виходу.
  const [opDirection, setOpDirection] = useState<CashDirectionValue>('IN');
  const openOpModal = (dir: CashDirectionValue) => {
    setOpDirection(dir);
    setOpOpen(true);
  };

  // Повтор фіскального чека — ролі POST /payments/:id/retry-fiscal (без приймальні).
  const retryFiscal = useRetryCashFiscal();
  // Стан на рядок: спільний isPending крутив би спінер на всіх рядках одразу.
  const [retryingId, setRetryingId] = useState<string | null>(null);
  // `void` в onClick: відмова вже на екрані (toast.error), проміс нікому не потрібен.
  const onRetryFiscal = async (op: CashOperation) => {
    if (!op.documentId || retryingId) return;
    setRetryingId(op.id);
    try {
      await retryFiscal.mutateAsync(op.documentId);
      toast.success(t('operations.fiscalRetryQueued'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('operations.fiscalRetryError'));
    } finally {
      setRetryingId(null);
    }
  };

  // Сторно: рядок тримаємо й після закриття — інакше картка порожніла б під час анімації виходу.
  const [reverseTarget, setReverseTarget] = useState<CashOperation | null>(null);
  const [reverseOpen, setReverseOpen] = useState(false);
  const openReverse = (op: CashOperation) => {
    setReverseTarget(op);
    setReverseOpen(true);
  };
  // Стабільний onClose: картка не має перезапускати ефекти через нову стрілку на кожен рендер.
  const closeReverse = useCallback(() => setReverseOpen(false), []);

  // Перехід між оригіналом і його сторно: прокрутити до рядка й коротко підсвітити.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  useEffect(() => {
    if (!highlightId) return;
    const timer = setTimeout(() => setHighlightId(null), JUMP_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);
  const jumpTo = (id: string) => {
    document
      .getElementById(rowDomId(id))
      ?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    setHighlightId(id);
  };
  const opsById = useMemo(
    () => new Map((operations ?? []).map(o => [o.id, o] as const)),
    [operations],
  );

  const openBaseDocument = (op: CashOperation) => {
    if (!op.baseDocumentId) return;
    if (op.baseDocumentType === 'WorkOrder') nav.toWorkOrder(op.baseDocumentId);
    else if (op.baseDocumentType === 'PurchaseOrder') nav.toPurchaseOrder(op.baseDocumentId);
  };

  const onOpenShift = async () => {
    if (!selected) return;
    try {
      await openShift.mutateAsync({ branchId: selected.branchId, cashRegisterId: selected.id });
      toast.success(t('operations.shiftOpened'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('operations.openShiftError'));
    }
  };
  const onCloseShift = async () => {
    if (!shift) return;
    try {
      await closeShift.mutateAsync(shift.id);
      toast.success(t('operations.shiftClosedToast'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('operations.closeShiftError'));
    }
  };

  // Фіскальна каса без відкритої зміни → операції заблоковані.
  const fiscalBlocked = !!selected?.isFiscal && !shift;

  if (regLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="md" />
      </div>
    );
  }
  // Список кас не завантажився — це не «кас немає»: порада створити касу тут була б неправдою
  // (Bug #850). Якщо список уже є в кеші, а впало лише фонове оновлення, працюємо з ним далі.
  if (regError && !registers) {
    return <ListLoadError error={regError} onRetry={() => void refetchRegisters()} />;
  }
  if ((registers?.length ?? 0) === 0) {
    return (
      <EmptyState
        icon={Wallet}
        title={t('operations.noRegisters')}
        description={t('operations.noRegistersDescription')}
      />
    );
  }

  const canDeposit = canOperate || receptionist;
  // Колонка дій — лише ролям зі сторно; інші не мають у ній жодної кнопки.
  const colCount = (isBaseCurrency ? 6 : 7) + (canOperate ? 1 : 0);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      {/* Каса + баланс | Пошук · З · По; дії каси «Внести / Видати» — праворуч, як основна кнопка списку */}
      <ListFiltersRow
        actions={
          canDeposit && (
            <>
              <Button
                leftIcon={<ArrowDownCircle className="h-4 w-4" />}
                onClick={() => openOpModal('IN')}
                disabled={fiscalBlocked}
              >
                {t('operations.deposit')}
              </Button>
              {canOperate && (
                <Button
                  variant="outline"
                  leftIcon={<ArrowUpCircle className="h-4 w-4" />}
                  onClick={() => openOpModal('OUT')}
                  disabled={fiscalBlocked}
                >
                  {t('operations.withdraw')}
                </Button>
              )}
            </>
          )
        }
      >
        <Select value={selectedId} onChange={e => setSelectedId(e.target.value)} className="w-48">
          {registers?.map(r => (
            <option key={r.id} value={r.id}>
              {r.name} {r.isFiscal ? t('operations.fiscalSuffix') : ''}
            </option>
          ))}
        </Select>
        {selected && (
          <div className="bg-surface border border-border rounded-lg px-4 py-2">
            <span className="text-[12px] text-muted-foreground">
              {t('operations.balanceLabel')}
            </span>
            <span className="text-lg font-bold tabular-nums">
              {fmtMoney(selected.balance)} {selected.currencySymbol ?? selected.currencyCode}
            </span>
          </div>
        )}
        {/* Роздільник: каса й залишок — ліворуч, фільтри списку — праворуч від нього */}
        <span aria-hidden="true" className="mx-3 hidden h-8 w-px bg-border md:block" />
        {/* Вужчий пошук — каса, залишок, пошук, період і «Внести / Видати» в одному рядку на
            1440 px (рішення власника 2026-10-29); повна підказка — у title */}
        <ListSearchInput
          value={search}
          onChange={setSearch}
          label={t('operations.searchPlaceholder')}
          widthClassName="w-36"
        />
        <DateRangeFilter
          from={dateFrom}
          to={dateTo}
          onFromChange={setDateFrom}
          onToChange={setDateTo}
          fromLabel={t('operations.dateFrom')}
          toLabel={t('operations.dateTo')}
        />
      </ListFiltersRow>

      {/* Зміна (для фіскальної каси) */}
      {selected?.isFiscal && (
        <div className="bg-surface border border-border rounded-lg px-4 py-2.5 flex items-center gap-3 shrink-0">
          {shiftLoading ? (
            <Spinner size="sm" />
          ) : shiftError ? (
            // Збій запиту ≠ «зміну закрито»: інакше касир бачить «Відкрити зміну» при відкритій
            // зміні (з BR-CASH-027 — ще й 404, коли касу вже перевели в іншу філію). Bug #962.
            <>
              <AlertTriangle className="h-3.5 w-3.5 text-warning-text" aria-hidden="true" />
              <span role="alert" className="text-[13px] text-warning-text">
                {t('operations.shiftLoadError')}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={() => void refetchShift()}
              >
                {t('common:retry')}
              </Button>
            </>
          ) : shift ? (
            <>
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-success" />
              <span className="text-[13px] font-medium">{t('operations.shiftOpen')}</span>
              {!!shift.pendingReceipts && shift.pendingReceipts > 0 && (
                <span className="flex items-center gap-1 text-[12px] text-warning-text">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {t('operations.pendingReceipts', { n: shift.pendingReceipts })}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={() => void onCloseShift()}
                loading={closeShift.isPending}
              >
                <DoorClosed className="h-3.5 w-3.5 mr-1" />
                {t('operations.closeShift')}
              </Button>
            </>
          ) : (
            <>
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-muted-foreground" />
              <span className="text-[13px] text-muted-foreground">
                {t('operations.shiftClosed')}
              </span>
              <Button
                size="sm"
                className="ml-auto"
                onClick={() => void onOpenShift()}
                loading={openShift.isPending}
              >
                <DoorOpen className="h-3.5 w-3.5 mr-1" />
                {t('operations.openShift')}
              </Button>
            </>
          )}
        </div>
      )}

      <ListLoadError error={opsError} onRetry={() => void refetchOps()} className="shrink-0" />

      {historyTruncated && (
        <p role="status" className="shrink-0 text-[12px] text-warning-text">
          {t('operations.historyTruncated', { n: CASH_HISTORY_LIMIT })}
        </p>
      )}

      {/* Історія операцій */}
      <div className="flex-1 min-h-0 border border-border rounded-xl bg-surface overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('operations.colDate')}</TableHead>
              <TableHead>{t('operations.colOperation')}</TableHead>
              <TableHead>{t('operations.colReason')}</TableHead>
              <TableHead>{t('operations.colParty')}</TableHead>
              <TableHead>{t('operations.colBase')}</TableHead>
              <TableHead className="text-right">{t('operations.colAmount')}</TableHead>
              {!isBaseCurrency && (
                <TableHead className="text-right">
                  {t('operations.colInBase', { symbol: baseSymbol })}
                </TableHead>
              )}
              {/* Sticky: на вузькому екрані таблиця ширша за контейнер, і дія «Сторнувати»
                  ховалась би за горизонтальною прокруткою (як у банківській виписці). */}
              {canOperate && (
                <TableHead className="sticky right-0 bg-secondary">
                  <span className="sr-only">{t('reversal.colActions')}</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {opsLoading && (
              <TableRow>
                <TableCell colSpan={colCount} className="py-10 text-center">
                  <div className="flex justify-center">
                    <Spinner size="md" />
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!opsLoading && !opsError && (operations?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={colCount} className="p-0">
                  <ListEmptyState
                    icon={Wallet}
                    title={t('operations.empty')}
                    description={t('operations.emptyDescription')}
                    filtered={hasOpsFilter}
                    onResetFilters={() => {
                      setSearch('');
                      setDateFrom('');
                      setDateTo('');
                    }}
                  />
                </TableCell>
              </TableRow>
            )}
            {operations?.map(op => {
              const reversed = !!op.reversedBy;
              const original = op.reversalOfId ? opsById.get(op.reversalOfId) : undefined;
              const reversalRowLoaded = !!op.reversedBy && opsById.has(op.reversedBy.id);
              const reasonLabel = t(`reasons.${op.reason}`, { defaultValue: op.reason });
              const amountText = `${fmtMoney(op.amount)} ${curSymbol}`.trim();
              return (
                <TableRow
                  key={op.id}
                  id={rowDomId(op.id)}
                  data-reversed={reversed || undefined}
                  data-reversal={op.reversalOfId ? true : undefined}
                  className={cn(
                    'group transition-colors',
                    highlightId === op.id && 'bg-warning-subtle',
                  )}
                >
                  <TableCell
                    className={cn(
                      'text-[13px] text-muted-foreground whitespace-nowrap',
                      reversed && 'opacity-60',
                    )}
                  >
                    {fmtDateTime(op.createdAt)}
                  </TableCell>
                  <TableCell className={cn(reversed && 'opacity-60')}>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 text-[13px] font-medium',
                        op.direction === 'IN' ? 'text-success' : 'text-destructive',
                      )}
                    >
                      {op.direction === 'IN' ? (
                        <ArrowDownCircle className="h-3.5 w-3.5" />
                      ) : (
                        <ArrowUpCircle className="h-3.5 w-3.5" />
                      )}
                      {op.direction === 'IN'
                        ? t('operations.directionIn')
                        : t('operations.directionOut')}
                    </span>
                  </TableCell>
                  {/* wrap-anywhere: примітка й причина сторно — до 500 символів; «слово» без
                      пробілів (посилання, номер) інакше розтягує таблицю, і суми всіх рядків
                      ідуть за прокрутку (Bug #855). */}
                  <TableCell className="text-[13px] text-muted-foreground wrap-anywhere">
                    <span className={cn(reversed && 'opacity-60')}>
                      {op.reversalOfId
                        ? t('reversal.marks.reversal', { reason: reasonLabel })
                        : reasonLabel}
                      {op.expenseCategoryName ? ` · ${op.expenseCategoryName}` : ''}
                      {op.notes ? ` · ${op.notes}` : ''}
                      {op.documentNumber ? ` · ${op.documentNumber}` : ''}
                    </span>
                    {op.fiscalStatus && (
                      <span className="ml-2 inline-flex items-center gap-1.5 align-middle">
                        <Badge
                          variant={FISCAL_STATUS_BADGE[op.fiscalStatus] ?? 'secondary'}
                          tooltip={FISCAL_STATUS_DESCRIPTIONS[op.fiscalStatus]}
                        >
                          {t('operations.fiscalBadge', {
                            status: fiscalStatusLabel(op.fiscalStatus),
                          })}
                        </Badge>
                        {/* Чек сторнованої оплати сервер скасовує — повторювати нічого. */}
                        {canOperate &&
                          op.fiscalStatus === 'FAILED' &&
                          op.documentId &&
                          !reversed &&
                          !op.reversalOfId && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={e => {
                                e.stopPropagation();
                                void onRetryFiscal(op);
                              }}
                              loading={retryingId === op.id}
                              disabled={retryingId !== null}
                            >
                              <RotateCw className="h-3.5 w-3.5 mr-1" />
                              {t('operations.fiscalRetry')}
                            </Button>
                          )}
                      </span>
                    )}
                    {op.reversedBy && (
                      <div className="mt-0.5 text-[12px] font-medium text-destructive-text">
                        {reversalRowLoaded ? (
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation();
                              if (op.reversedBy) jumpTo(op.reversedBy.id);
                            }}
                            title={t('reversal.marks.reversedAria')}
                            className="text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-sm"
                          >
                            {t('reversal.marks.reversed', {
                              reason: op.reversedBy.reason || '—',
                              date: fmtDateTime(op.reversedBy.createdAt),
                            })}
                          </button>
                        ) : (
                          t('reversal.marks.reversed', {
                            reason: op.reversedBy.reason || '—',
                            date: fmtDateTime(op.reversedBy.createdAt),
                          })
                        )}
                      </div>
                    )}
                    {op.reversalOfId && (
                      <div className="mt-0.5 text-[12px]">
                        {original ? (
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation();
                              jumpTo(original.id);
                            }}
                            aria-label={t('reversal.marks.originalAria', {
                              date: fmtDateTime(original.createdAt),
                            })}
                            className="text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-sm"
                          >
                            {t('reversal.marks.original', {
                              date: fmtDateTime(original.createdAt),
                              amount: `${fmtMoney(original.amount)} ${curSymbol}`.trim(),
                            })}
                          </button>
                        ) : (
                          <span>{t('reversal.marks.originalOutside')}</span>
                        )}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className={cn('text-[13px]', reversed && 'opacity-60')}>
                    {op.counterpartyName || op.employeeName || (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell
                    className={cn('text-[13px] whitespace-nowrap', reversed && 'opacity-60')}
                  >
                    {op.baseDocumentId &&
                    op.baseDocumentNumber &&
                    op.baseDocumentType === 'PurchaseOrder' &&
                    !canOpenPurchaseOrders ? (
                      op.baseDocumentNumber
                    ) : op.baseDocumentId && op.baseDocumentNumber ? (
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation();
                          openBaseDocument(op);
                        }}
                        title={t('operations.openBaseAria', { number: op.baseDocumentNumber })}
                        aria-label={t('operations.openBaseAria', {
                          number: op.baseDocumentNumber,
                        })}
                        className="text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-sm"
                      >
                        {op.baseDocumentNumber}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular-nums font-semibold whitespace-nowrap',
                      op.direction === 'IN' ? 'text-success' : 'text-destructive',
                      reversed && 'line-through opacity-60',
                    )}
                  >
                    {op.direction === 'IN' ? '+' : '−'}
                    {fmtMoney(op.amount)} {curSymbol}
                  </TableCell>
                  {!isBaseCurrency && (
                    <TableCell
                      className={cn(
                        'text-right tabular-nums text-muted-foreground',
                        reversed && 'line-through opacity-60',
                      )}
                    >
                      {op.amountBase != null ? `${fmtMoney(op.amountBase)} ${baseSymbol}` : '—'}
                    </TableCell>
                  )}
                  {canOperate && (
                    <TableCell
                      className={cn(
                        'sticky right-0 text-right whitespace-nowrap',
                        // Липка комірка має власне тло — підсвітка рядка мусить лягти й на неї.
                        highlightId === op.id
                          ? 'bg-warning-subtle'
                          : 'bg-surface group-hover:bg-secondary',
                      )}
                    >
                      {/* Сторно — рідкісна незворотна дія: у меню «⋯», підтвердження — картка сторно
                          з причиною (UX-огляд 2026-10-29). */}
                      {isReversible(op) && (
                        <RowActionsMenu
                          actions={[
                            {
                              key: 'reverse',
                              label: t('reversal.action'),
                              icon: <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />,
                              destructive: true,
                              // BR-PAY-029: чек у черзі ПРРО може бути вже в дорозі — сервер
                              // сторно відмовить, тож дія вимкнена з поясненням.
                              disabledReason:
                                op.fiscalStatus === 'QUEUED'
                                  ? t('reversal.fiscalQueued')
                                  : undefined,
                              onSelect: () => openReverse(op),
                            },
                          ]}
                        />
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <CashOperationModal
        open={opOpen}
        onClose={() => setOpOpen(false)}
        direction={opDirection}
        register={selected}
        allowedReasons={canOperate ? undefined : RECEPTIONIST_CASH_REASONS}
        categoriesEnabled={canOperate}
      />

      <CashReversalModal
        open={reverseOpen}
        onClose={closeReverse}
        operation={reverseTarget}
        currencySymbol={curSymbol}
      />
    </div>
  );
}
