'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DoorOpen,
  DoorClosed,
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { toast } from '@/lib/toast';
import { fmtMoney, fmtDateTime, kyivToday } from '@/lib/format';
import { DateRangeFilter } from '@/components/ui/date-range-filter';
import { ListSearchInput } from '@/components/ui/list-search-input';
import { useDebounce } from '@/hooks/useDebounce';
import { cn } from '@/lib/utils';
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
  useCreateCashOperation,
  useBaseCurrency,
  MANUAL_IN_REASONS,
  MANUAL_OUT_REASONS,
} from '@/hooks/api/useCash';
import { useExpenseCategories, flattenActiveByType } from '@/hooks/api/useExpenseCategories';

export default function CashOperationsTab({ canOperate = false }: { canOperate?: boolean }) {
  const { t } = useTranslation('cash');
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
  const { data: operations, isLoading: opsLoading } = useCashOperations(
    selectedId || null,
    opsFilter,
  );
  // Статті витрат потрібні лише для модалки IN/OUT (привід EXPENSE), доступної тим, хто canOperate.
  // GET /expense-categories вимагає ACCOUNTANT+ — RECEPTIONIST (лише перегляд) інакше отримав би 403.
  const { data: expenseCats } = useExpenseCategories(false, canOperate);
  const createOp = useCreateCashOperation();

  const [opModal, setOpModal] = useState<null | 'IN' | 'OUT'>(null);
  const [opForm, setOpForm] = useState({
    amount: '',
    reason: '',
    expenseCategoryId: '',
    notes: '',
  });
  const [opError, setOpError] = useState('');

  const openOpModal = (dir: 'IN' | 'OUT') => {
    setOpForm({
      amount: '',
      reason: dir === 'IN' ? 'MANUAL_IN' : 'MANUAL_OUT',
      expenseCategoryId: '',
      notes: '',
    });
    setOpError('');
    setOpModal(dir);
  };

  // `void` в onClick: обробник сам ловить помилку у catch і показує її користувачу
  // (банер setError / toast.error) — проміс більше нікому не потрібен.
  const submitOp = async () => {
    if (!opModal || !selected) return;
    const amount = Number(opForm.amount);
    if (!(amount > 0)) {
      setOpError(t('operations.amountRequired'));
      return;
    }
    if (opForm.reason === 'EXPENSE' && !opForm.expenseCategoryId) {
      setOpError(t('operations.categoryRequired'));
      return;
    }
    try {
      await createOp.mutateAsync({
        cashRegisterId: selected.id,
        direction: opModal,
        amount,
        reason: opForm.reason,
        expenseCategoryId: opForm.expenseCategoryId || undefined,
        notes: opForm.notes || undefined,
      });
      setOpModal(null);
      toast.success(opModal === 'IN' ? t('operations.deposited') : t('operations.withdrawn'));
    } catch (e) {
      setOpError(e instanceof Error ? e.message : t('operations.opError'));
    }
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

  const reasonOptions = opModal === 'IN' ? MANUAL_IN_REASONS : MANUAL_OUT_REASONS;
  // Статті відповідного напряму: IN → оприбуткування (INCOME), OUT → витрати (EXPENSE). Сплощене
  // дерево з відступами для читабельності ієрархії у Select.
  const categoryOptions = flattenActiveByType(expenseCats, opModal === 'IN' ? 'INCOME' : 'EXPENSE');

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
        {canOperate && (
          <div className="ml-auto flex items-center gap-2">
            <Button
              leftIcon={<ArrowDownCircle className="h-4 w-4" />}
              onClick={() => openOpModal('IN')}
              disabled={fiscalBlocked}
            >
              {t('operations.deposit')}
            </Button>
            <Button
              variant="outline"
              leftIcon={<ArrowUpCircle className="h-4 w-4" />}
              onClick={() => openOpModal('OUT')}
              disabled={fiscalBlocked}
            >
              {t('operations.withdraw')}
            </Button>
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

      {/* Історія операцій */}
      <div className="flex-1 min-h-0 border border-border rounded-xl bg-surface overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('operations.colDate')}</TableHead>
              <TableHead>{t('operations.colOperation')}</TableHead>
              <TableHead>{t('operations.colReason')}</TableHead>
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
                <TableCell colSpan={isBaseCurrency ? 4 : 5} className="py-10 text-center">
                  <div className="flex justify-center">
                    <Spinner size="md" />
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!opsLoading && (operations?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={isBaseCurrency ? 4 : 5} className="p-0">
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

      {/* Модалка внести/видати */}
      <Modal
        open={!!opModal}
        onClose={() => setOpModal(null)}
        title={opModal === 'IN' ? t('operations.modalTitleIn') : t('operations.modalTitleOut')}
        footer={
          <Button
            onClick={() => void submitOp()}
            loading={createOp.isPending}
            disabled={!(Number(opForm.amount) > 0)}
            className="w-full"
          >
            {opModal === 'IN' ? t('operations.deposit') : t('operations.withdraw')}
          </Button>
        }
      >
        {opError && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
            {opError}
          </div>
        )}
        <div className="space-y-4">
          <Input
            label={t('operations.fieldAmount')}
            type="number"
            required
            value={opForm.amount}
            onChange={e => setOpForm(f => ({ ...f, amount: e.target.value }))}
            placeholder="0"
            autoFocus
            className="h-8 text-[13px]"
          />
          <Select
            label={t('operations.fieldReason')}
            value={opForm.reason}
            onChange={e => setOpForm(f => ({ ...f, reason: e.target.value }))}
          >
            {reasonOptions.map(r => (
              <option key={r} value={r}>
                {t(`reasons.${r}`, { defaultValue: r })}
              </option>
            ))}
          </Select>
          <Select
            label={
              opForm.reason === 'EXPENSE'
                ? t('operations.fieldCategoryExpense')
                : opModal === 'IN'
                  ? t('operations.fieldCategoryIncomeOptional')
                  : t('operations.fieldCategoryExpenseOptional')
            }
            value={opForm.expenseCategoryId}
            onChange={e => setOpForm(f => ({ ...f, expenseCategoryId: e.target.value }))}
          >
            <option value="">{t('operations.categoryNone')}</option>
            {categoryOptions.map(c => (
              <option key={c.id} value={c.id}>
                {'  '.repeat(c.depth)}
                {c.name}
              </option>
            ))}
          </Select>
          <Input
            label={t('operations.fieldNotes')}
            value={opForm.notes}
            onChange={e => setOpForm(f => ({ ...f, notes: e.target.value }))}
            placeholder={t('operations.notesPlaceholder')}
            className="h-8 text-[13px]"
          />
        </div>
      </Modal>
    </div>
  );
}
