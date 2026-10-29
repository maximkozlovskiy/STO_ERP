'use client';

import { Fragment, useCallback, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { Calculator, Wallet, Trash2, ChevronRight, ChevronDown } from 'lucide-react';
import { useRequireAuth, useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import { StatusPill } from '@/components/ui/status-pill';
import { ListFiltersRow, ListStatusRow } from '@/components/ui/list-toolbar';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { TableContainer } from '@/components/ui/table-container';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { useConfirm } from '@/hooks/useConfirm';
import { useListPage } from '@/hooks/useListPage';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/lib/toast';
import { fmtDate, fmtMoney, fmtQty } from '@/lib/format';
import {
  usePayrollPeriods,
  usePayrollPeriod,
  useComputePayrollPeriod,
  usePayPayrollPeriod,
  useDeletePayrollPeriod,
  type PayrollLine,
  type PayrollPeriod,
} from '@/hooks/api/usePayroll';
import { EMPTY_ITEMS } from '@/hooks/api/usePaginatedList';
import { ListLoadError } from '@/components/ui/list-load-error';
import { useCashRegisters } from '@/hooks/api/useCash';
import { CatalogHelp } from '@/components/ui/help-popover';

// Вікно розрахунку відкривається лише кнопкою — його код (поля дат із календарем) не входить у
// first-load сторінки (бюджет сторінок, check-page-budget.mjs).
const PayrollPreviewModal = dynamic(
  () => import('./PayrollPreviewModal').then(m => m.PayrollPreviewModal),
  { ssr: false },
);

const STATUS_BADGE: Record<PayrollPeriod['status'], BadgeVariant> = {
  DRAFT: 'secondary',
  COMPUTED: 'warning',
  PAID: 'success',
  CANCELLED: 'secondary',
};

// Module-level frozen дефолти (еталон work-orders): стабільна референція, нуль allocate
// у render; статуси дзеркалять PAYROLL_PERIOD_STATUSES у payroll.dto.ts.
// `as const` обов'язковий: без нього Object.freeze дає string[], і STATUS_LABELS[s]
// не індексується (TS7053).
const PERIOD_STATUSES = Object.freeze(['DRAFT', 'COMPUTED', 'PAID', 'CANCELLED'] as const);

// labelKey idiom — мітки резолвляться через t() у компоненті, persistence по `key`.
const PERIOD_COLUMN_DEFS: Array<{ key: string; labelKey: string }> = [
  { key: 'period', labelKey: 'periods.columns.period' },
  { key: 'note', labelKey: 'periods.columns.note' },
  { key: 'status', labelKey: 'periods.columns.status' },
  { key: 'totalAccrued', labelKey: 'periods.columns.totalAccrued' },
  { key: 'totalPaid', labelKey: 'periods.columns.totalPaid' },
  { key: 'computedAt', labelKey: 'periods.columns.computedAt' },
];
const PERIOD_COLUMNS_DEFAULT_KEYS_JSON = JSON.stringify(PERIOD_COLUMN_DEFS.map(c => c.key));

interface PayrollFilters extends Record<string, unknown> {
  status: string;
}

export default function PayrollPage() {
  const { t } = useTranslation('payroll');
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT']);
  const { employee } = useAuth();
  const canPay = ['OWNER', 'ADMIN'].includes(employee?.role ?? '');
  const { confirm, dialogProps } = useConfirm();

  const STATUS_LABELS = useMemo<Record<PayrollPeriod['status'], string>>(
    () => ({
      DRAFT: t('status.DRAFT'),
      COMPUTED: t('status.COMPUTED'),
      PAID: t('status.PAID'),
      CANCELLED: t('status.CANCELLED'),
    }),
    [t],
  );
  const RATE_LABELS = useMemo<Record<string, string>>(
    () => ({
      percent_normo: t('rateScheme.percent_normo'),
      per_normo_hour: t('rateScheme.per_normo_hour'),
      fixed_plus_bonus: t('rateScheme.fixed_plus_bonus'),
      unknown: t('rateScheme.unknown'),
    }),
    [t],
  );
  // BR-PAYR-016: умови схеми рядка («% від суми робіт · 40 %»). Виведені з нарахування (рядок
  // розраховано до знімка умов) — з «≈»; невідомі умови — лише назва схеми.
  const schemeTerms = useCallback(
    (l: PayrollLine): string => {
      const p = l.rateParams;
      const approx = l.rateDerived ? t('rateTerms.approx') : '';
      if (l.rateSchemeType === 'percent_normo' && p?.percent != null)
        return t('rateTerms.percent_normo', { approx, percent: fmtQty(p.percent) });
      if (l.rateSchemeType === 'per_normo_hour' && p?.ratePerHour != null)
        return t('rateTerms.per_normo_hour', { approx, rate: fmtMoney(p.ratePerHour) });
      if (
        l.rateSchemeType === 'fixed_plus_bonus' &&
        p?.fixedMonthly != null &&
        p.bonusPercent != null
      )
        return t('rateTerms.fixed_plus_bonus', {
          approx,
          fixed: fmtMoney(p.fixedMonthly),
          bonus: fmtQty(p.bonusPercent),
        });
      return RATE_LABELS[l.rateSchemeType] ?? l.rateSchemeType;
    },
    [t, RATE_LABELS],
  );
  const PERIOD_COLUMNS = useMemo(
    () => PERIOD_COLUMN_DEFS.map(c => ({ ...c, label: t(c.labelKey) })),
    [t],
  );

  // useListPage: пагінація + колонки + збережені фільтри (§25.3). Bulk-select НЕ підключаємо —
  // compute/pay строго по одному періоду (FSM), масові операції тут шкідливі.
  const {
    page,
    setPage,
    resetPage,
    activeSavedFilterId,
    setActiveSavedFilterId,
    tableColumns: {
      visibleColumns,
      orderedColumns,
      visibleKeys: colVisible,
      order,
      customLabels,
      toggle: toggleCol,
      reorder,
      renameColumn,
      resetConfig,
    },
    dragProps,
    savedFilters: { saved: savedFilters, save: saveFilter, remove: removeFilter },
    features,
    limit,
  } = useListPage<PayrollFilters>('payroll-periods', PERIOD_COLUMNS, { defaultLimit: 20 });

  const [statusFilter, setStatusFilter] = useState('');

  const [previewOpen, setPreviewOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Вкладене розкриття рядка співробітника → розшифровка по нарядах (`${periodId}:${employeeId}`).
  const [expandedEmployee, setExpandedEmployee] = useState<string | null>(null);
  // Модалка виплати: обрати касу (готівкою) або без каси (лише фіксація).
  const [payPeriod, setPayPeriod] = useState<PayrollPeriod | null>(null);
  const [payCashRegisterId, setPayCashRegisterId] = useState('');
  const { data: cashRegisters } = useCashRegisters();

  const periodsQuery = usePayrollPeriods({ page, limit, status: statusFilter });
  // Розкритий період вантажиться детально (список не несе розшифровки по нарядах — важко).
  const expandedDetail = usePayrollPeriod(expanded);
  const computeMut = useComputePayrollPeriod();
  const payMut = usePayPayrollPeriod();
  const deleteMut = useDeletePayrollPeriod();

  // Стабільна порожня референція (EMPTY_ITEMS) — Bug #328 guard.
  const periods = periodsQuery.data?.items ?? (EMPTY_ITEMS as unknown as PayrollPeriod[]);
  const total = periodsQuery.data?.total ?? 0;
  const totalPages = Math.ceil(total / limit) || 1;
  // +1 — колонка-стрілка розкриття, +1 — колонка кнопок дій (не входять у COLUMNS).
  const periodColSpan = visibleColumns.length + 2;

  const changeStatus = useCallback(
    (value: string) => {
      setStatusFilter(value);
      resetPage();
      setActiveSavedFilterId(null);
      // Розкриття скидаємо — рядок може зникнути з поточної сторінки.
      setExpanded(null);
      setExpandedEmployee(null);
    },
    [resetPage, setActiveSavedFilterId],
  );

  const applyFilter = useCallback(
    (preset: { id: string; filters: PayrollFilters }) => {
      setStatusFilter(preset.filters.status ?? '');
      resetPage();
      setActiveSavedFilterId(preset.id);
      setExpanded(null);
      setExpandedEmployee(null);
    },
    [resetPage, setActiveSavedFilterId],
  );

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = saveFilter(name, { status: statusFilter });
      setActiveSavedFilterId(preset.id);
      toast.success(t('filters.filterSaved', { name }));
    },
    [saveFilter, statusFilter, setActiveSavedFilterId, t],
  );

  const changePage = useCallback(
    (p: number) => {
      setPage(p);
      setExpanded(null);
      setExpandedEmployee(null);
    },
    [setPage],
  );

  const compute = async (id: string) => {
    try {
      await computeMut.mutateAsync(id);
      toast.success(t('toast.computed'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('toast.computeError'));
    }
  };

  const pay = (p: PayrollPeriod) => {
    setPayCashRegisterId('');
    setPayPeriod(p);
  };

  const confirmPay = async () => {
    if (!payPeriod) return;
    try {
      await payMut.mutateAsync({
        id: payPeriod.id,
        cashRegisterId: payCashRegisterId || undefined,
      });
      setPayPeriod(null);
      toast.success(t('toast.paid'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('toast.payError'));
    }
  };

  const remove = async (p: PayrollPeriod) => {
    if (
      !(await confirm({
        title: t('confirm.deleteTitle'),
        message: t('confirm.deleteMessage'),
        variant: 'destructive',
      }))
    )
      return;
    try {
      await deleteMut.mutateAsync(p.id);
      toast.success(t('toast.periodDeleted'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('toast.deleteError'));
    }
  };

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <div className="flex items-center gap-2">
          <h1 className="page-title">{t('title')}</h1>
          {/* BR-PAYR-001/002/004–008/015/016 */}
          <CatalogHelp ns="payroll" topic="help" align="start" width="lg" />
        </div>
      </div>

      {features.savedFiltersEnabled && savedFilters.length > 0 && (
        <SavedFiltersBar<PayrollFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          hideSaveButton
        />
      )}

      <ListStatusRow label={t('filters.statusLabel')}>
        {(['', ...PERIOD_STATUSES] as const).map(s => (
          <StatusPill
            key={s}
            value={s}
            label={s ? STATUS_LABELS[s] : t('filters.all')}
            active={statusFilter === s}
            onSelect={changeStatus}
          />
        ))}
      </ListStatusRow>

      <ListFiltersRow
        actions={
          <>
            {features.savedFiltersEnabled && <SaveFilterButton onSave={handleSaveFilter} />}
            <ColumnsDropdown
              columns={orderedColumns}
              visibleKeys={colVisible}
              onToggle={toggleCol}
              onReorder={reorder}
              onRename={renameColumn}
              onReset={resetConfig}
              hasCustomization={
                JSON.stringify(order) !== PERIOD_COLUMNS_DEFAULT_KEYS_JSON ||
                Object.keys(customLabels).length > 0
              }
            />
            <Button
              leftIcon={<Calculator className="h-4 w-4" />}
              onClick={() => setPreviewOpen(true)}
            >
              {t('preview.open')}
            </Button>
          </>
        }
      />

      <div className="flex flex-1 min-h-0">
        <TableContainer>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                {visibleColumns.map(col => (
                  <TableHead
                    key={col.key}
                    className={
                      col.key === 'totalAccrued' || col.key === 'totalPaid'
                        ? 'text-right'
                        : undefined
                    }
                    {...dragProps(col.key)}
                  >
                    {col.label}
                  </TableHead>
                ))}
                <TableHead />
              </TableRow>
            </TableHeader>

            {periodsQuery.isLoading && (
              <TableBody>
                <TableRow>
                  <TableCell colSpan={periodColSpan} className="py-12 text-center">
                    <div className="flex justify-center">
                      <Spinner size="md" />
                    </div>
                  </TableCell>
                </TableRow>
              </TableBody>
            )}
            {!periodsQuery.isLoading && periods.length === 0 && (
              <TableBody>
                <TableRow>
                  <TableCell colSpan={periodColSpan} className="p-0">
                    <EmptyState
                      icon={Wallet}
                      size="sm"
                      title={t('empty.periodsTitle')}
                      description={
                        statusFilter ? t('empty.noMatchDescription') : t('empty.periodsHint')
                      }
                    />
                  </TableCell>
                </TableRow>
              </TableBody>
            )}

            {/* Один <tbody> на період: тримає рядок-шапку + розкриту розшифровку під спільним
                data-testid (E2E скоупить статус/кнопки/drill-down на цей вузол). */}
            {periods.map(p => {
              const isOpen = expanded === p.id;
              // Детальний запит несе workOrders; поки вантажиться — дані зі списку.
              const lines = expandedDetail.data?.id === p.id ? expandedDetail.data.lines : p.lines;
              return (
                <TableBody key={p.id} data-testid={`payroll-period-${p.id}`}>
                  <TableRow>
                    <TableCell className="w-8 pr-0">
                      <button
                        onClick={() => {
                          setExpanded(isOpen ? null : p.id);
                          setExpandedEmployee(null);
                        }}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={isOpen ? t('periods.collapse') : t('periods.expand')}
                      >
                        {isOpen ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </button>
                    </TableCell>
                    {visibleColumns.map(col => {
                      if (col.key === 'period')
                        return (
                          <TableCell key="period" className="font-medium whitespace-nowrap">
                            {fmtDate(p.periodStart)} — {fmtDate(p.periodEnd)}
                          </TableCell>
                        );
                      if (col.key === 'note')
                        return (
                          <TableCell key="note" className="text-muted-foreground">
                            {p.note || '—'}
                          </TableCell>
                        );
                      if (col.key === 'status')
                        return (
                          <TableCell key="status">
                            <Badge variant={STATUS_BADGE[p.status]}>
                              {STATUS_LABELS[p.status]}
                            </Badge>
                          </TableCell>
                        );
                      if (col.key === 'totalAccrued')
                        return (
                          <TableCell
                            key="totalAccrued"
                            className="text-right tabular-nums font-semibold whitespace-nowrap"
                          >
                            {fmtMoney(p.totalAccrued)} ₴
                          </TableCell>
                        );
                      if (col.key === 'totalPaid')
                        return (
                          <TableCell
                            key="totalPaid"
                            className="text-right tabular-nums whitespace-nowrap"
                          >
                            {fmtMoney(p.totalPaid)} ₴
                          </TableCell>
                        );
                      if (col.key === 'computedAt')
                        return (
                          <TableCell key="computedAt" className="text-muted-foreground">
                            {/* Мітка часу: дата за Києвом (fmtDate), а не UTC-зріз ISO-рядка. */}
                            {fmtDate(p.computedAt)}
                          </TableCell>
                        );
                      return null;
                    })}
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {p.status === 'DRAFT' && (
                          <Button
                            size="sm"
                            onClick={() => void compute(p.id)}
                            loading={computeMut.isPending && computeMut.variables === p.id}
                          >
                            {t('periods.compute')}
                          </Button>
                        )}
                        {p.status === 'COMPUTED' && canPay && (
                          <Button
                            size="sm"
                            onClick={() => void pay(p)}
                            loading={payMut.isPending && payMut.variables?.id === p.id}
                          >
                            {t('periods.pay')}
                          </Button>
                        )}
                        {p.status !== 'PAID' && canPay && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => void remove(p)}
                            title={t('periods.delete')}
                            className="text-destructive/70 hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>

                  {isOpen && (!lines || lines.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={periodColSpan} className="bg-secondary/20">
                        <p className="text-[12px] text-muted-foreground py-1">
                          {p.status === 'DRAFT'
                            ? t('periods.notComputed')
                            : t('periods.noAccruals')}
                        </p>
                      </TableCell>
                    </TableRow>
                  )}

                  {isOpen && lines && lines.length > 0 && (
                    <TableRow>
                      <TableCell colSpan={periodColSpan} className="bg-secondary/20 p-0">
                        <table className="w-full text-[13px]">
                          <colgroup>
                            <col className="w-8" />
                            <col />
                            <col className="w-64" />
                            <col className="w-24" />
                            <col className="w-28" />
                            <col className="w-28" />
                          </colgroup>
                          <thead>
                            <tr className="text-[12px] text-muted-foreground border-b border-border/50">
                              <th />
                              <th className="text-left font-medium px-4 py-1.5">
                                {t('columns.employee')}
                              </th>
                              <th className="text-left font-medium py-1.5">
                                {t('columns.scheme')}
                              </th>
                              <th className="text-right font-medium py-1.5">
                                {t('columns.normoHours')}
                              </th>
                              <th className="text-right font-medium py-1.5">
                                {t('columns.accrued')}
                              </th>
                              <th className="text-right font-medium py-1.5 pr-4">
                                {t('columns.paid')}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {lines.map(l => {
                              const empKey = `${p.id}:${l.employeeId}`;
                              const empOpen = expandedEmployee === empKey;
                              const wos = l.workOrders;
                              // BR-PAYR-016: нараховане по нарядах невідоме лише для «оклад +
                              // бонус» без знімка умов — тоді колонку не показуємо.
                              const showAccrued = !!wos && wos.every(w => w.accruedAmount != null);
                              return (
                                <Fragment key={l.employeeId}>
                                  <tr className="border-b border-border/50">
                                    <td className="w-8 pl-2">
                                      <button
                                        onClick={() => setExpandedEmployee(empOpen ? null : empKey)}
                                        className="text-muted-foreground hover:text-foreground"
                                        aria-label={
                                          empOpen ? t('breakdown.collapse') : t('breakdown.expand')
                                        }
                                        title={
                                          empOpen ? t('breakdown.collapse') : t('breakdown.expand')
                                        }
                                      >
                                        {empOpen ? (
                                          <ChevronDown className="h-3.5 w-3.5" />
                                        ) : (
                                          <ChevronRight className="h-3.5 w-3.5" />
                                        )}
                                      </button>
                                    </td>
                                    <td className="font-medium px-4 py-1.5">{l.employeeName}</td>
                                    <td className="py-1.5 text-muted-foreground">
                                      <span
                                        title={
                                          l.rateDerived ? t('rateTerms.derivedTitle') : undefined
                                        }
                                      >
                                        {schemeTerms(l)}
                                      </span>
                                    </td>
                                    <td className="py-1.5 text-right tabular-nums">
                                      {fmtQty(l.normoHours)}
                                    </td>
                                    <td className="py-1.5 text-right tabular-nums font-semibold">
                                      {fmtMoney(l.accruedAmount)}
                                    </td>
                                    <td className="py-1.5 pr-4 text-right tabular-nums">
                                      {fmtMoney(l.paidAmount ?? 0)}
                                    </td>
                                  </tr>
                                  {empOpen && (
                                    <tr>
                                      <td colSpan={6} className="bg-secondary/30 p-0">
                                        {expandedDetail.isLoading ? (
                                          <div className="flex justify-center py-4">
                                            <Spinner size="sm" />
                                          </div>
                                        ) : !wos || wos.length === 0 ? (
                                          <p className="text-[12px] text-muted-foreground px-4 py-3">
                                            {/* linesCount 0 — окладник без робіт за період
                                                (BR-PAYR-001): розшифровки немає, бо немає нарядів,
                                                а не тому, що період старий. */}
                                            {l.linesCount === 0
                                              ? t('breakdown.noWorks')
                                              : t('breakdown.empty')}
                                          </p>
                                        ) : (
                                          <div className="px-4 py-2">
                                            <p className="text-[12px] font-medium text-muted-foreground mb-1.5">
                                              {t('breakdown.heading')}
                                            </p>
                                            <table className="w-full text-[13px]">
                                              <colgroup>
                                                <col className="w-32" />
                                                <col />
                                                <col className="w-20" />
                                                <col className="w-24" />
                                                <col className="w-28" />
                                                {showAccrued && <col className="w-28" />}
                                              </colgroup>
                                              <thead>
                                                <tr className="text-[12px] text-muted-foreground">
                                                  <th className="text-left font-medium py-1">
                                                    {t('breakdown.workOrder')}
                                                  </th>
                                                  <th className="text-left font-medium py-1">
                                                    {t('breakdown.vehicle')}
                                                  </th>
                                                  <th className="text-right font-medium py-1">
                                                    {t('breakdown.works')}
                                                  </th>
                                                  <th className="text-right font-medium py-1">
                                                    {t('columns.normoHours')}
                                                  </th>
                                                  <th className="text-right font-medium py-1">
                                                    {t('columns.baseAmount')}
                                                  </th>
                                                  {showAccrued && (
                                                    <th className="text-right font-medium py-1">
                                                      {t('columns.accrued')}
                                                    </th>
                                                  )}
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {wos.map(w => (
                                                  <tr
                                                    key={w.workOrderId}
                                                    className="border-t border-border/50"
                                                  >
                                                    <td className="py-1.5">
                                                      <Link
                                                        href={`/work-orders/${w.workOrderId}`}
                                                        className="text-primary hover:underline"
                                                      >
                                                        {w.workOrderNumber}
                                                      </Link>
                                                    </td>
                                                    <td className="py-1.5 text-muted-foreground">
                                                      {w.vehicleName ?? '—'}
                                                    </td>
                                                    <td className="py-1.5 text-right tabular-nums">
                                                      {w.worksCount}
                                                    </td>
                                                    <td className="py-1.5 text-right tabular-nums">
                                                      {fmtQty(w.normoHours)}
                                                    </td>
                                                    <td className="py-1.5 text-right tabular-nums">
                                                      {fmtMoney(w.baseAmount)}
                                                    </td>
                                                    {showAccrued && (
                                                      <td className="py-1.5 text-right tabular-nums">
                                                        {fmtMoney(w.accruedAmount)}
                                                      </td>
                                                    )}
                                                  </tr>
                                                ))}
                                                {showAccrued && l.fixedPart != null && (
                                                  <tr className="border-t border-border/50">
                                                    <td
                                                      colSpan={5}
                                                      className="py-1.5 text-muted-foreground"
                                                    >
                                                      {t('breakdown.fixedPart')}
                                                    </td>
                                                    <td className="py-1.5 text-right tabular-nums">
                                                      {fmtMoney(l.fixedPart)}
                                                    </td>
                                                  </tr>
                                                )}
                                              </tbody>
                                              <tfoot>
                                                <tr className="border-t border-border font-semibold">
                                                  <td colSpan={3} className="py-1.5">
                                                    {t('breakdown.total')}
                                                  </td>
                                                  <td className="py-1.5 text-right tabular-nums">
                                                    {fmtQty(l.normoHours)}
                                                  </td>
                                                  <td className="py-1.5 text-right tabular-nums">
                                                    {fmtMoney(l.baseAmount)}
                                                  </td>
                                                  {showAccrued && (
                                                    <td className="py-1.5 text-right tabular-nums">
                                                      {fmtMoney(l.accruedAmount)}
                                                    </td>
                                                  )}
                                                </tr>
                                              </tfoot>
                                            </table>
                                            <p className="text-[11px] text-muted-foreground mt-1.5">
                                              {showAccrued
                                                ? t('breakdown.note')
                                                : t('breakdown.noAccruedNote')}
                                            </p>
                                          </div>
                                        )}
                                      </td>
                                    </tr>
                                  )}
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              );
            })}
          </Table>
        </TableContainer>
      </div>

      <Pagination page={page} totalPages={totalPages} onChange={changePage} />

      <PayrollPreviewModal open={previewOpen} onClose={() => setPreviewOpen(false)} />

      {/* Модалка виплати */}
      <Modal
        open={!!payPeriod}
        onClose={() => setPayPeriod(null)}
        title={t('payModal.title')}
        footer={
          <Button onClick={() => void confirmPay()} loading={payMut.isPending} className="w-full">
            {t('periods.pay')} {payPeriod ? fmtMoney(payPeriod.totalAccrued) : ''} ₴
          </Button>
        }
      >
        {payPeriod && (
          <div className="space-y-4">
            <p className="text-[13px] text-muted-foreground">
              {t('payModal.periodInfo', {
                from: fmtDate(payPeriod.periodStart),
                to: fmtDate(payPeriod.periodEnd),
              })}
              <b>{fmtMoney(payPeriod.totalAccrued)} ₴</b>
              {t('payModal.cannotUndo')}
            </p>
            <Select
              label={t('payModal.cashRegisterLabel')}
              value={payCashRegisterId}
              onChange={e => setPayCashRegisterId(e.target.value)}
            >
              <option value="">{t('payModal.noCashRegister')}</option>
              {cashRegisters?.map(r => (
                <option key={r.id} value={r.id}>
                  {t('payModal.cashRegisterOption', {
                    name: r.name,
                    balance: fmtMoney(r.balance),
                    currency: r.currencySymbol ?? r.currencyCode,
                  })}
                </option>
              ))}
            </Select>
            <p className="text-[12px] text-muted-foreground">{t('payModal.note')}</p>
          </div>
        )}
      </Modal>

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
