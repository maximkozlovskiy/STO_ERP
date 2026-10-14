'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DoorOpen,
  DoorClosed,
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  RotateCw,
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
import { EmptyState } from '@/components/ui/empty-state';
import { ListLoadError } from '@/components/ui/list-load-error';
import { toast } from '@/lib/toast';
import { fmtMoney, fmtDateTime, kyivToday } from '@/lib/format';
import { DateRangeFilter } from '@/components/ui/date-range-filter';
import { ListSearchInput } from '@/components/ui/list-search-input';
import { useDebounce } from '@/hooks/useDebounce';
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
import { useCurrentShift, useOpenShift, useCloseShift } from '@/hooks/api/useCashShift';
import {
  useCashRegisters,
  useCashOperations,
  useRetryCashFiscal,
  useBaseCurrency,
  type CashOperation,
} from '@/hooks/api/useCash';
import { CashOperationModal } from './CashOperationModal';

interface Props {
  /** Усі ручні операції — власник, адміністратор, бухгалтер. */
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
  const { data: registers, isLoading: regLoading } = useCashRegisters();
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

  const { data: shift, isLoading: shiftLoading } = useCurrentShift(selected?.branchId ?? null);
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
  } = useCashOperations(selectedId || null, opsFilter);
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

  const openBaseDocument = (op: CashOperation) => {
    if (!op.baseDocumentId) return;
    if (op.baseDocumentType === 'WorkOrder') nav.toWorkOrder(op.baseDocumentId);
    else if (op.baseDocumentType === 'PurchaseOrder') nav.toPurchaseOrder(op.baseDocumentId);
  };

  const onOpenShift = async () => {
    if (!selected) return;
    try {
      await openShift.mutateAsync(selected.branchId);
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
  const colCount = isBaseCurrency ? 6 : 7;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      {/* Каса + баланс */}
      <div className="flex flex-wrap items-center gap-3 shrink-0">
        <Select value={selectedId} onChange={e => setSelectedId(e.target.value)} className="w-56">
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
        {canDeposit && (
          <div className="ml-auto flex items-center gap-2">
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
          </div>
        )}
      </div>

      {/* Зміна (для фіскальної каси) */}
      {selected?.isFiscal && (
        <div className="bg-surface border border-border rounded-lg px-4 py-2.5 flex items-center gap-3 shrink-0">
          {shiftLoading ? (
            <Spinner size="sm" />
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

      {/* Пошук · З · По */}
      <div className="flex flex-wrap items-center gap-3 shrink-0">
        <ListSearchInput
          value={search}
          onChange={setSearch}
          label={t('operations.searchPlaceholder')}
        />
        <DateRangeFilter
          from={dateFrom}
          to={dateTo}
          onFromChange={setDateFrom}
          onToChange={setDateTo}
          fromLabel={t('operations.dateFrom')}
          toLabel={t('operations.dateTo')}
        />
      </div>

      <ListLoadError error={opsError} onRetry={() => void refetchOps()} className="shrink-0" />

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
                  <EmptyState
                    icon={Wallet}
                    title={t('operations.empty')}
                    description={t(
                      hasOpsFilter
                        ? 'operations.emptyFilteredDescription'
                        : 'operations.emptyDescription',
                    )}
                  />
                </TableCell>
              </TableRow>
            )}
            {operations?.map(op => (
              <TableRow key={op.id}>
                <TableCell className="text-[13px] text-muted-foreground whitespace-nowrap">
                  {fmtDateTime(op.createdAt)}
                </TableCell>
                <TableCell>
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
                <TableCell className="text-[13px] text-muted-foreground">
                  {t(`reasons.${op.reason}`, { defaultValue: op.reason })}
                  {op.expenseCategoryName ? ` · ${op.expenseCategoryName}` : ''}
                  {op.notes ? ` · ${op.notes}` : ''}
                  {op.documentNumber ? ` · ${op.documentNumber}` : ''}
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
                      {canOperate && op.fiscalStatus === 'FAILED' && op.documentId && (
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
                </TableCell>
                <TableCell className="text-[13px]">
                  {op.counterpartyName || op.employeeName || (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-[13px] whitespace-nowrap">
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
                      aria-label={t('operations.openBaseAria', { number: op.baseDocumentNumber })}
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
                    'text-right tabular-nums font-semibold',
                    op.direction === 'IN' ? 'text-success' : 'text-destructive',
                  )}
                >
                  {op.direction === 'IN' ? '+' : '−'}
                  {fmtMoney(op.amount)} {curSymbol}
                </TableCell>
                {!isBaseCurrency && (
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {op.amountBase != null ? `${fmtMoney(op.amountBase)} ${baseSymbol}` : '—'}
                  </TableCell>
                )}
              </TableRow>
            ))}
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
    </div>
  );
}
