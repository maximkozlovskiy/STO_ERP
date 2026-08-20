'use client';

import { Suspense, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Wallet, Search, Eye, EyeOff, Trash2, Check, Ban, ExternalLink } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/auth';
import { useDebounce } from '@/hooks/useDebounce';
import { apiFetch } from '@/lib/api-client';
import {
  useSupplierPayments,
  useConfirmSupplierPayment,
  useCancelSupplierPayment,
  useDeleteSupplierPayment,
  supplierPaymentsKeys,
  type SupplierPayment,
} from '@/hooks/api/useSupplierPayments';
import { EMPTY_ITEMS } from '@/hooks/api/usePaginatedList';
import {
  SUPPLIER_PAYMENT_STATUS_LABELS,
  SUPPLIER_PAYMENT_STATUS_BADGE,
  SUPPLIER_PAYMENT_STATUS_DESCRIPTIONS,
  PAYMENT_SOURCE_TYPE_LABELS,
} from '@sto/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Pagination } from '@/components/ui/pagination';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { StatusPill } from '@/components/ui/status-pill';
import { DetailPanel, PanelField, PanelSection } from '@/components/ui/detail-panel';
import {
  SUPPLIER_PAYMENT_PANEL_SCHEMA,
  buildPanelFields,
  schemaToPanelConfigFields,
} from '@/lib/panel-schema';
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import { useListPage } from '@/hooks/useListPage';
import { useBulkIndeterminate } from '@/hooks/useBulkIndeterminate';
import { SupplierPaymentCreateModal } from '@/components/ui/SupplierPaymentCreateModal';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  SortableHead,
  TableCell,
} from '@/components/ui/table';
import { useSortState } from '@/hooks/useSortState';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { fmtMoney, fmtDate } from '@/lib/format';

const STATUS_OPTIONS = ['DRAFT', 'CONFIRMED', 'CANCELLED'] as const;

function fmt(n: number) {
  return fmtMoney(n) + ' ₴';
}

interface SpFilters extends Record<string, unknown> {
  status: string;
  q: string;
  showDeleted: boolean;
  dateFrom: string;
  dateTo: string;
}

// Module-level — статичні колонки + прекомпьютений JSON для hasCustomization.
const COLUMNS: Array<{ key: string; label: string; defaultVisible?: boolean }> = [
  { key: 'number', label: 'Номер', defaultVisible: true },
  { key: 'supplier', label: 'Постачальник', defaultVisible: true },
  { key: 'source', label: 'Джерело', defaultVisible: true },
  { key: 'method', label: 'Метод', defaultVisible: true },
  { key: 'amount', label: 'Сума', defaultVisible: true },
  { key: 'date', label: 'Дата', defaultVisible: true },
  { key: 'status', label: 'Статус', defaultVisible: true },
];
const COLUMNS_DEFAULT_KEYS_JSON = JSON.stringify(COLUMNS.map(c => c.key));

function SupplierPaymentsPageInner() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT']);
  const { confirm, dialogProps } = useConfirm();
  const queryClient = useQueryClient();
  const router = useRouter();

  const {
    page,
    setPage,
    resetPage,
    showDeleted,
    setShowDeleted,
    activeSavedFilterId,
    setActiveSavedFilterId,
    tableColumns: {
      visibleKeys: colVisible,
      visibleColumns,
      orderedColumns,
      order,
      customLabels,
      toggle: toggleCol,
      reorder,
      renameColumn,
      resetConfig,
    },
    dragProps,
    detailPanel,
    panelConfig,
    savedFilters: { saved: savedFilters, save: saveFilter, remove: removeFilter },
    features,
    limit,
  } = useListPage<SpFilters>('supplier-payments', COLUMNS, { defaultLimit: 20 });

  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selected, setSelected] = useState<SupplierPayment | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const { sort, toggle: toggleSort } = useSortState('createdAt', 'desc');

  const debouncedQ = useDebounce(q, 300);

  const { data, isLoading, error } = useSupplierPayments({
    page,
    limit,
    status: status || undefined,
    q: debouncedQ || undefined,
    showDeleted,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    sortBy: sort.sortBy,
    sortDir: sort.sortDir,
  });

  const items = data?.items ?? (EMPTY_ITEMS as unknown as SupplierPayment[]);
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const { selectAllRef, ...bulkSelect } = useBulkIndeterminate(items);

  const confirmMut = useConfirmSupplierPayment();
  const cancelMut = useCancelSupplierPayment();
  const deleteMut = useDeleteSupplierPayment();

  const applyFilter = useCallback(
    (preset: { id: string; filters: SpFilters }) => {
      setStatus(preset.filters.status ?? '');
      setQ(preset.filters.q ?? '');
      setShowDeleted(preset.filters.showDeleted ?? false);
      setDateFrom(preset.filters.dateFrom ?? '');
      setDateTo(preset.filters.dateTo ?? '');
      resetPage();
      setActiveSavedFilterId(preset.id);
    },
    [resetPage, setActiveSavedFilterId, setShowDeleted],
  );

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = saveFilter(name, { status, q, showDeleted, dateFrom, dateTo });
      setActiveSavedFilterId(preset.id);
      if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
    },
    [
      saveFilter,
      status,
      q,
      showDeleted,
      dateFrom,
      dateTo,
      features.toastEnabled,
      setActiveSavedFilterId,
    ],
  );

  const handleConfirm = useCallback(
    async (sp: SupplierPayment) => {
      const ok = await confirm({
        title: 'Провести оплату?',
        message: `Оплата ${sp.number} на суму ${fmt(sp.amount)} зменшить борг перед постачальником. Після проведення документ не можна редагувати.`,
        confirmLabel: 'Провести',
      });
      if (!ok) return;
      try {
        const updated = await confirmMut.mutateAsync(sp.id);
        setSelected(updated);
        toast.success('Оплату проведено');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Помилка проведення');
      }
    },
    [confirm, confirmMut],
  );

  const handleCancel = useCallback(
    async (sp: SupplierPayment) => {
      const ok = await confirm({
        title: 'Скасувати оплату?',
        message: `Оплату ${sp.number} буде скасовано.`,
        confirmLabel: 'Скасувати оплату',
        variant: 'destructive',
      });
      if (!ok) return;
      try {
        const updated = await cancelMut.mutateAsync(sp.id);
        setSelected(updated);
        toast.success('Оплату скасовано');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Помилка скасування');
      }
    },
    [confirm, cancelMut],
  );

  const handleDelete = useCallback(
    async (sp: SupplierPayment) => {
      const ok = await confirm({
        title: 'Помітити на видалення?',
        message: `Оплату ${sp.number} буде помічено як видалену.`,
        confirmLabel: 'Видалити',
        variant: 'destructive',
      });
      if (!ok) return;
      try {
        await deleteMut.mutateAsync(sp.id);
        setSelected(null);
        toast.success('Оплату видалено');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Помилка видалення');
      }
    },
    [confirm, deleteMut],
  );

  const bulkDeleteSelected = useCallback(
    async (ids: string[]) => {
      if (
        !(await confirm({
          title: `Видалити ${ids.length} оплат?`,
          confirmLabel: 'Видалити',
          variant: 'destructive',
        }))
      )
        return;
      const results = await Promise.allSettled(
        ids.map(id => apiFetch(`/supplier-payments/${id}`, { method: 'DELETE' })),
      );
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.length - succeeded;
      bulkSelect.clear();
      queryClient.invalidateQueries({ queryKey: supplierPaymentsKeys.all });
      if (features.toastEnabled) {
        if (succeeded > 0 && failed === 0) toast.success(`Видалено ${succeeded} оплат`);
        else if (succeeded > 0)
          toast.warning(`Видалено ${succeeded} з ${results.length}. ${failed} не вдалось`);
        else toast.error('Не вдалося видалити оплати');
      }
    },
    [confirm, bulkSelect, features.toastEnabled, queryClient],
  );

  const bulkActions = useMemo<BulkAction[]>(
    () => [
      {
        id: 'delete',
        label: 'Видалити вибрані',
        variant: 'destructive',
        onClick: bulkDeleteSelected,
      },
    ],
    [bulkDeleteSelected],
  );

  const panelConfigFields = useMemo(
    () => schemaToPanelConfigFields(SUPPLIER_PAYMENT_PANEL_SCHEMA, panelConfig.config),
    [panelConfig.config],
  );

  const panelFields = useMemo(() => {
    if (!selected) return [];
    return buildPanelFields(selected, SUPPLIER_PAYMENT_PANEL_SCHEMA, panelConfig.config, {
      status: v => (
        <Badge
          variant={SUPPLIER_PAYMENT_STATUS_BADGE[String(v)] ?? 'secondary'}
          tooltip={SUPPLIER_PAYMENT_STATUS_DESCRIPTIONS[String(v)]}
        >
          {SUPPLIER_PAYMENT_STATUS_LABELS[String(v)] ?? String(v)}
        </Badge>
      ),
    });
  }, [selected, panelConfig.config]);

  const renderCell = (sp: SupplierPayment, key: string) => {
    switch (key) {
      case 'number':
        return (
          <TableCell key="number" className="font-medium text-[13px]">
            {sp.number}
            {sp.deletedAt && (
              <Badge variant="destructive" className="ml-2 text-[10px] px-1 py-0">
                видалено
              </Badge>
            )}
          </TableCell>
        );
      case 'supplier':
        return (
          <TableCell key="supplier" className="text-[13px]">
            {sp.supplierName ?? '—'}
          </TableCell>
        );
      case 'source':
        return (
          <TableCell key="source" className="text-[13px]">
            <span className="text-muted-foreground">
              {PAYMENT_SOURCE_TYPE_LABELS[sp.sourceType] ?? sp.sourceType}
            </span>
            {sp.sourceName ? ` · ${sp.sourceName}` : ''}
          </TableCell>
        );
      case 'method':
        return (
          <TableCell key="method" className="text-[13px] text-muted-foreground">
            {sp.method}
          </TableCell>
        );
      case 'amount':
        return (
          <TableCell key="amount" className="text-right tabular-nums font-semibold text-[13px]">
            {fmt(sp.amount)}
          </TableCell>
        );
      case 'date':
        return (
          <TableCell key="date" className="tabular-nums text-[13px] text-muted-foreground">
            {fmtDate(sp.documentDate)}
          </TableCell>
        );
      case 'status':
        return (
          <TableCell key="status">
            <Badge
              variant={SUPPLIER_PAYMENT_STATUS_BADGE[sp.status] ?? 'secondary'}
              tooltip={SUPPLIER_PAYMENT_STATUS_DESCRIPTIONS[sp.status]}
            >
              {SUPPLIER_PAYMENT_STATUS_LABELS[sp.status] ?? sp.status}
            </Badge>
          </TableCell>
        );
      default:
        return null;
    }
  };

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <h1 className="page-title flex items-center gap-2">
          <Wallet className="h-5 w-5" />
          Оплати постачальникам
        </h1>
        <Button onClick={() => setShowCreate(true)} leftIcon={<Plus className="h-4 w-4" />}>
          Нова оплата
        </Button>
      </div>

      {error && (
        <div className="mb-4 text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error instanceof Error ? error.message : 'Помилка завантаження'}
        </div>
      )}

      {/* Saved filters */}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<SpFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          hideSaveButton
        />
      )}

      {/* Status filter pills */}
      <div className="flex flex-wrap gap-1.5 shrink-0">
        <StatusPill
          value=""
          label="Усі"
          active={status === ''}
          onSelect={() => {
            setStatus('');
            resetPage();
            setActiveSavedFilterId(null);
          }}
        />
        {STATUS_OPTIONS.map(s => (
          <StatusPill
            key={s}
            value={s}
            label={SUPPLIER_PAYMENT_STATUS_LABELS[s]}
            description={SUPPLIER_PAYMENT_STATUS_DESCRIPTIONS[s]}
            active={status === s}
            onSelect={v => {
              setStatus(v);
              resetPage();
              setActiveSavedFilterId(null);
            }}
          />
        ))}
      </div>

      {/* Filters row */}
      <div className="flex flex-wrap items-center gap-3 shrink-0">
        <Input
          value={q}
          onChange={e => {
            setQ(e.target.value);
            resetPage();
            setActiveSavedFilterId(null);
          }}
          placeholder="Пошук за номером / постачальником…"
          leftElement={<Search />}
          className="w-64 h-8 text-[13px]"
        />
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-muted-foreground shrink-0">Від</span>
          <DatePickerInput
            value={dateFrom}
            onChange={v => {
              setDateFrom(v);
              resetPage();
              setActiveSavedFilterId(null);
            }}
            max={dateTo || undefined}
            className="w-36"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-muted-foreground shrink-0">До</span>
          <DatePickerInput
            value={dateTo}
            onChange={v => {
              setDateTo(v);
              resetPage();
              setActiveSavedFilterId(null);
            }}
            min={dateFrom || undefined}
            className="w-36"
          />
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="outline"
            size="icon-sm"
            title={showDeleted ? 'Сховати видалені' : 'Показати видалені'}
            onClick={() => {
              setShowDeleted(v => !v);
              resetPage();
              setActiveSavedFilterId(null);
            }}
            className={cn(showDeleted && 'border-primary text-primary')}
          >
            {showDeleted ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
          {features.savedFiltersEnabled && <SaveFilterButton onSave={handleSaveFilter} />}
          <ColumnsDropdown
            columns={orderedColumns}
            visibleKeys={colVisible}
            onToggle={toggleCol}
            onReorder={reorder}
            onRename={renameColumn}
            onReset={resetConfig}
            hasCustomization={
              JSON.stringify(order) !== COLUMNS_DEFAULT_KEYS_JSON ||
              Object.keys(customLabels).length > 0
            }
          />
          <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
        </div>
      </div>

      {/* Bulk actions */}
      {features.bulkActionsEnabled && bulkSelect.count > 0 && (
        <BulkActionsBar
          count={bulkSelect.count}
          selectedIds={Array.from(bulkSelect.selected)}
          actions={bulkActions}
          onClear={bulkSelect.clear}
        />
      )}

      {/* Table + DetailPanel */}
      <div className="flex flex-1 min-h-0">
        <div className="table-scroll-container flex-1 min-h-0 min-w-0 overflow-auto bg-surface border border-border rounded-xl">
          <Table>
            <TableHeader>
              <TableRow>
                {features.bulkActionsEnabled && (
                  <TableHead className="w-9 pr-0">
                    <input
                      type="checkbox"
                      checked={bulkSelect.allSelected}
                      ref={selectAllRef}
                      onChange={bulkSelect.toggleAll}
                      className="h-3.5 w-3.5 rounded border-border"
                      aria-label="Вибрати всі"
                    />
                  </TableHead>
                )}
                {visibleColumns.map(col => {
                  // Ключ колонки → поле сортування бекенду (whitelist SORT_FIELDS у service).
                  const SORTABLE: Record<string, string> = {
                    number: 'number',
                    amount: 'amount',
                    date: 'documentDate',
                  };
                  const sortKey = SORTABLE[col.key];
                  if (sortKey)
                    return (
                      <SortableHead
                        key={col.key}
                        sortKey={sortKey}
                        currentSort={sort}
                        onSort={toggleSort}
                        className={col.key === 'amount' ? 'text-right' : undefined}
                        {...dragProps(col.key)}
                      >
                        {col.label}
                      </SortableHead>
                    );
                  return (
                    <TableHead key={col.key} {...dragProps(col.key)}>
                      {col.label}
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell
                    colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 1 : 0)}
                    className="py-12 text-center"
                  >
                    <div className="flex justify-center">
                      <Spinner size="md" />
                    </div>
                  </TableCell>
                </TableRow>
              )}

              {!isLoading && items.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 1 : 0)}
                    className="p-0"
                  >
                    <EmptyState
                      icon={Wallet}
                      title="Оплат ще немає"
                      description="Створіть першу оплату постачальнику для закриття боргу."
                    />
                  </TableCell>
                </TableRow>
              )}

              {!isLoading &&
                items.map(sp => (
                  <TableRow
                    key={sp.id}
                    onClick={() =>
                      detailPanel.enabled && setSelected(prev => (prev?.id === sp.id ? null : sp))
                    }
                    className={cn(
                      'group transition-colors',
                      detailPanel.enabled && 'cursor-pointer',
                      sp.deletedAt && 'opacity-60',
                      selected?.id === sp.id && detailPanel.enabled && 'bg-primary/5',
                      bulkSelect.isSelected(sp.id) && 'bg-primary/5',
                    )}
                  >
                    {features.bulkActionsEnabled && (
                      <TableCell className="w-9 pr-0" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={bulkSelect.isSelected(sp.id)}
                          onChange={() => bulkSelect.toggle(sp.id)}
                          className="h-3.5 w-3.5 rounded border-border"
                          aria-label={`Вибрати оплату ${sp.number}`}
                        />
                      </TableCell>
                    )}
                    {visibleColumns.map(col => renderCell(sp, col.key))}
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>

        {/* Detail panel */}
        <DetailPanel
          open={!!selected && detailPanel.enabled}
          onClose={() => setSelected(null)}
          title={selected?.number ?? ''}
          subtitle={selected?.supplierName}
          configFields={panelConfigFields}
          onToggleField={panelConfig.toggleField}
          onReorderFields={panelConfig.reorderFields}
          onReset={panelConfig.reset}
        >
          {selected && (
            <>
              {panelFields.map(f => (
                <PanelField
                  key={f.key}
                  fieldKey={f.key}
                  label={f.label}
                  value={f.value}
                  hidden={f.hidden}
                />
              ))}

              <Button
                variant="outline"
                size="sm"
                leftIcon={<ExternalLink className="h-4 w-4" />}
                onClick={() => router.push(`/supplier-payments/${selected.id}`)}
              >
                Відкрити картку
              </Button>

              {!selected.deletedAt && (
                <PanelSection title="Дії">
                  <div className="flex flex-col gap-2">
                    {selected.status === 'DRAFT' && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          leftIcon={<Check className="h-4 w-4" />}
                          loading={confirmMut.isPending}
                          onClick={() => void handleConfirm(selected)}
                        >
                          Провести
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          leftIcon={<Ban className="h-4 w-4" />}
                          loading={cancelMut.isPending}
                          onClick={() => void handleCancel(selected)}
                        >
                          Скасувати
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          leftIcon={<Trash2 className="h-4 w-4" />}
                          loading={deleteMut.isPending}
                          onClick={() => void handleDelete(selected)}
                        >
                          Помітити на видалення
                        </Button>
                      </>
                    )}
                    {selected.status === 'CANCELLED' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={<Trash2 className="h-4 w-4" />}
                        loading={deleteMut.isPending}
                        onClick={() => void handleDelete(selected)}
                      >
                        Помітити на видалення
                      </Button>
                    )}
                  </div>
                </PanelSection>
              )}
            </>
          )}
        </DetailPanel>
      </div>

      {/* Pagination */}
      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      <SupplierPaymentCreateModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSaved={() => setPage(1)}
      />

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

export default function SupplierPaymentsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      }
    >
      <SupplierPaymentsPageInner />
    </Suspense>
  );
}
