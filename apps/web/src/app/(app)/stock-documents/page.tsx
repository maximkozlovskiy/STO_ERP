'use client';

import { Suspense, useState, useCallback, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useStockDocuments, stockDocsKeys } from '@/hooks/api/useStockDocuments';
import { EMPTY_ITEMS } from '@/hooks/api/usePaginatedList';
import { Plus, FileText, Eye, EyeOff, Trash2, Pencil } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  STOCK_DOC_TYPE_LABELS,
  STOCK_DOC_TYPE_BADGE,
  STOCK_DOC_TYPE_DESCRIPTIONS,
  STOCK_DOC_STATUS_LABELS,
  STOCK_DOC_STATUS_BADGE,
  STOCK_DOC_STATUS_DESCRIPTIONS,
} from '@sto/shared';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pagination } from '@/components/ui/pagination';
import { useConfirm } from '@/hooks/useConfirm';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { StockDocumentCreateModal } from '@/components/ui/StockDocumentCreateModal';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
// Bug #504: DetailPanel було повністю dead (selectedDoc state ніколи не set non-null).
// Видалено разом з useDetailPanel/useDetailPanelConfig destructure та STOCK_DOC_PANEL_SCHEMA helpers.
// Row click веде в edit modal через setEditingDocId — це реальний flow для перегляду документа.
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
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { useListPage } from '@/hooks/useListPage';
import { useBulkIndeterminate } from '@/hooks/useBulkIndeterminate';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { fmtMoney, fmtDate, fmtDateTime, kyivToday } from '@/lib/format';
import { StatusPill } from '@/components/ui/status-pill';

// Module-level formatter — produces YYYY-MM-DD in Kyiv local time (DST-aware).

interface DocLine {
  id?: string;
  goodId: string;
  goodName?: string;
  goodSku?: string | null;
  unit?: string;
  unitShortName?: string;
  coefficient?: number;
  quantity: number;
  price: number | null;
}
interface StockDoc {
  id: string;
  number: string;
  type: string;
  status: string;
  branchId: string;
  branchName?: string | null;
  warehouseId: string;
  warehouseName?: string;
  targetWarehouseId?: string | null;
  targetWarehouseName?: string | null;
  notes: string | null;
  confirmedAt?: string | null;
  documentDate?: string | null;
  // List endpoint omits `lines` and supplies `linesCount` (perf: -20K row marshalling).
  // findOne (/stock-documents/:id) returns full lines[] for DetailPanel — fetched lazily.
  lines?: DocLine[];
  linesCount?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}
interface Paginated {
  items: StockDoc[];
  total: number;
  page: number;
  limit: number;
}

interface StockDocFilters extends Record<string, unknown> {
  typeFilter: string;
  statusFilter: string;
  showDeleted: boolean;
  dateFrom: string;
  dateTo: string;
}

// Module-level — статичні колонки + прекомпьютений JSON для hasCustomization.
const COLUMNS: Array<{ key: string; label: string }> = [
  { key: 'number', label: 'Номер' },
  { key: 'type', label: 'Тип' },
  { key: 'warehouse', label: 'Склад' },
  { key: 'status', label: 'Статус' },
  { key: 'lines', label: 'Позицій' },
  { key: 'date', label: 'Дата документа' },
];
const COLUMNS_DEFAULT_KEYS_JSON = JSON.stringify(COLUMNS.map(c => c.key));

// Filter tab arrays derived from shared constants — single source of truth.
// Adding a new type to STOCK_DOC_TYPE_LABELS automatically appears as a tab.
const TYPE_FILTERS: readonly string[] = Object.freeze(['', ...Object.keys(STOCK_DOC_TYPE_LABELS)]);
const STATUS_FILTERS: readonly string[] = Object.freeze([
  '',
  ...Object.keys(STOCK_DOC_STATUS_LABELS),
]);
// Module-level Set for O(1) lookup of valid URL `?type=` values (avoids re-allocating
// `Object.keys()` array on every render in `typeFromUrl` validation below).
const VALID_TYPES: ReadonlySet<string> = new Set(Object.keys(STOCK_DOC_TYPE_LABELS));

function StockDocumentsPageClient() {
  useRequireAuth(['OWNER', 'ADMIN', 'STOREKEEPER']);

  const { confirm, dialogProps } = useConfirm();

  // useListPage: shared table/panel/filter infrastructure
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
    // Bug #504/#505: detailPanel + panelConfig видалено (DetailPanel мертвий, toggle нічого не контролював).
    savedFilters: { saved: savedFilters, save: saveFilter, remove: removeFilter },
    features,
    limit,
  } = useListPage<StockDocFilters>('stock-documents', COLUMNS, { defaultLimit: 20 });

  // Local filter state (specific to stock-documents)
  const searchParams = useSearchParams();
  const router = useRouter();
  const typeFromUrl = searchParams.get('type') ?? '';
  const typeFilter = VALID_TYPES.has(typeFromUrl) ? typeFromUrl : '';
  const setTypeFilter = useCallback(
    (t: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (t) params.set('type', t);
      else params.delete('type');
      // scroll: false — keep current scroll position (otherwise switching tabs scrolls
      // page-fill container to top, which is jarring in long lists).
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState(() => kyivToday());
  const [dateTo, setDateTo] = useState(() => kyivToday());
  const { sort: sdSort, toggle: toggleSdSort } = useSortState('createdAt', 'desc');

  const qc = useQueryClient();
  const { data: docsData, isLoading: loading } = useStockDocuments({
    page,
    limit,
    type: typeFilter || undefined,
    status: statusFilter || undefined,
    showDeleted,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    sortBy: sdSort.sortBy,
    sortDir: sdSort.sortDir,
  });
  // Bug #328 regression guard — stable empty array reference.
  const docs = docsData?.items ?? (EMPTY_ITEMS as unknown as StockDoc[]);
  const total = docsData?.total ?? 0;
  const invalidate = () => qc.invalidateQueries({ queryKey: stockDocsKeys.all });
  // Bug #465: оголошуємо `load` поряд з invalidate, щоб handleBulkDelete/handleTransition/markDeleted
  // що його використовують посилались на вже визначену константу (а не на TDZ-trap при copy-paste у refactor).
  const load = invalidate;
  const [error, setError] = useState('');

  // Bug #504: selectedDoc state removed — DetailPanel was dead (state ніколи не set non-null).
  const [showCreate, setShowCreate] = useState(false);
  const [editingDocId, setEditingDocId] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState<StockDoc | null>(null);

  // Open the standalone detail Modal (FSM buttons, full table).
  // List endpoint omits `lines` (perf: -20K line rows per page) — fetch full doc
  // via GET /stock-documents/:id and upgrade once it arrives.
  const openDetailModal = useCallback(async (doc: StockDoc) => {
    setShowDetail(doc);
    try {
      const detail = await apiFetch<StockDoc>(`/stock-documents/${doc.id}`);
      setShowDetail(prev => (prev?.id === doc.id ? detail : prev));
    } catch {
      // keep basic doc data if detail fetch fails — table renders empty body
    }
  }, []);

  const [saving, setSaving] = useState(false);

  const applyFilter = useCallback(
    (preset: { id: string; filters: StockDocFilters }) => {
      setTypeFilter(preset.filters.typeFilter ?? '');
      setStatusFilter(preset.filters.statusFilter ?? '');
      setShowDeleted(preset.filters.showDeleted ?? false);
      setDateFrom(preset.filters.dateFrom ?? '');
      setDateTo(preset.filters.dateTo ?? '');
      resetPage();
      setActiveSavedFilterId(preset.id);
    },
    [setTypeFilter, setShowDeleted, resetPage, setActiveSavedFilterId],
  );

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = saveFilter(name, { typeFilter, statusFilter, showDeleted, dateFrom, dateTo });
      setActiveSavedFilterId(preset.id);
      if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
    },
    [
      saveFilter,
      typeFilter,
      statusFilter,
      showDeleted,
      dateFrom,
      dateTo,
      features.toastEnabled,
      setActiveSavedFilterId,
    ],
  );

  const { selectAllRef, ...bulkSelect } = useBulkIndeterminate(docs);

  // `load` is intentionally omitted from deps — it's recreated each render
  // but its input (filters from page state) is captured at click time via
  // closure. Including it would invalidate the callback on every keystroke.
  const handleBulkDelete = useCallback(
    async (ids: string[]) => {
      if (
        !(await confirm({
          title: `Видалити ${ids.length} документ(ів)?`,
          confirmLabel: 'Видалити',
          variant: 'destructive',
        }))
      )
        return;
      const results = await Promise.allSettled(
        ids.map(id => apiFetch(`/stock-documents/${id}`, { method: 'DELETE' })),
      );
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.length - succeeded;
      bulkSelect.clear();
      load();
      if (features.toastEnabled) {
        if (succeeded > 0 && failed === 0) {
          toast.success(`Видалено ${succeeded} документ(ів)`);
        } else if (succeeded > 0 && failed > 0) {
          toast.warning(`Видалено ${succeeded} з ${results.length}. ${failed} не вдалось`);
        } else {
          toast.error('Не вдалося видалити документи');
        }
      } else if (failed > 0) {
        setError(`${succeeded} з ${results.length} документів видалено, ${failed} не вдалось`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bulkSelect, confirm, features.toastEnabled],
  );

  const bulkActions = useMemo<BulkAction[]>(
    () => [
      {
        id: 'delete',
        label: 'Видалити вибрані',
        variant: 'destructive',
        icon: <Trash2 className="h-3.5 w-3.5 mr-1.5" />,
        onClick: handleBulkDelete,
      },
    ],
    [handleBulkDelete],
  );

  const totalPages = Math.ceil(total / limit) || 1;

  // sto-optimize: stable refs — handlers used у inline row onClick wrappers; useCallback
  // дозволяє в майбутньому пройти React.memo на TableRow без identity-thrashing.
  // `load` ref recreates on each invalidation, але семантика та сама — deps eslint-disable.
  const handleTransition = useCallback(
    async (doc: StockDoc, newStatus: string) => {
      const label = newStatus === 'CONFIRMED' ? 'підтвердити' : 'скасувати';
      if (!(await confirm({ title: `Бажаєте ${label} документ ${doc.number}?` }))) return;
      setSaving(true);
      setError('');
      try {
        await apiFetch<StockDoc>(`/stock-documents/${doc.id}/transition`, {
          method: 'POST',
          body: JSON.stringify({ status: newStatus }),
        });
        setShowDetail(null);
        load();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Помилка зміни статусу');
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [confirm],
  );

  const markDeleted = useCallback(
    async (doc: StockDoc) => {
      if (
        !(await confirm({
          title: `Позначити документ ${doc.number} на видалення?`,
          variant: 'destructive',
        }))
      )
        return;
      try {
        await apiFetch(`/stock-documents/${doc.id}`, { method: 'DELETE' });
        load();
        toast.success('Документ позначено на видалення');
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : 'Помилка видалення');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [confirm],
  );

  // Bug #504: buildDocTabs видалено — використовувалось виключно у dead DetailPanel.
  // Перегляд позицій документа доступний через edit modal (openDetailModal/setEditingDocId).

  return (
    <div className="page-fill p-4 md:p-6">
      {error && (
        <div className="mb-4 text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}
      <div className="page-header">
        <div>
          <h1 className="page-title">Складські документи</h1>
        </div>
      </div>

      {/* Saved filters */}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<StockDocFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          hideSaveButton
        />
      )}

      {/* Type tabs */}
      <div className="shrink-0 flex gap-0 border-b border-border -mx-6 px-6 overflow-x-auto">
        {TYPE_FILTERS.map(t => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTypeFilter(t);
              resetPage();
              setActiveSavedFilterId(null);
            }}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:rounded-sm',
              typeFilter === t
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border',
            )}
          >
            {t ? STOCK_DOC_TYPE_LABELS[t] : 'Всі'}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 shrink-0">
        {/* Status filters */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide mr-1">
            Статус
          </span>
          {STATUS_FILTERS.map(s => (
            <StatusPill
              key={s}
              value={s}
              label={s ? STOCK_DOC_STATUS_LABELS[s] : 'Всі'}
              active={statusFilter === s}
              description={s ? STOCK_DOC_STATUS_DESCRIPTIONS[s] : undefined}
              onSelect={v => {
                setStatusFilter(v);
                resetPage();
                setActiveSavedFilterId(null);
              }}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-muted-foreground shrink-0">З</span>
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
          <span className="text-[13px] text-muted-foreground shrink-0">По</span>
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
          {/* Bug #505: DetailPanelToggle видалено — toggle нічого не контролював (DetailPanel мертвий, Bug #504). */}
          <Button onClick={() => setShowCreate(true)} leftIcon={<Plus className="h-4 w-4" />}>
            {typeFilter ? STOCK_DOC_TYPE_LABELS[typeFilter] : 'Документ'}
          </Button>
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
                  const sortable = ['date'].includes(col.key);
                  if (sortable)
                    return (
                      <SortableHead
                        key={col.key}
                        sortKey="documentDate"
                        currentSort={sdSort}
                        onSort={toggleSdSort}
                        {...dragProps(col.key)}
                      >
                        {col.label}
                      </SortableHead>
                    );
                  return (
                    <TableHead
                      key={col.key}
                      className={col.key === 'lines' ? 'text-right' : undefined}
                      {...dragProps(col.key)}
                    >
                      {col.label}
                    </TableHead>
                  );
                })}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell
                    colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)}
                    className="py-10 text-center"
                  >
                    <div className="flex justify-center">
                      <Spinner size="md" />
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!loading && docs.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)}
                    className="p-0"
                  >
                    <EmptyState icon={FileText} title="Документів не знайдено" />
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                docs.map(doc => (
                  <TableRow
                    key={doc.id}
                    className={cn(
                      'group transition-colors cursor-pointer',
                      bulkSelect.isSelected(doc.id) && 'bg-primary/5',
                      doc.deletedAt && 'opacity-60',
                    )}
                    onClick={() => {
                      setEditingDocId(doc.id);
                    }}
                  >
                    {features.bulkActionsEnabled && (
                      <TableCell className="w-9 pr-0" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={bulkSelect.isSelected(doc.id)}
                          onChange={() => bulkSelect.toggle(doc.id)}
                          className="h-3.5 w-3.5 rounded border-border"
                          aria-label={`Вибрати документ ${doc.number}`}
                        />
                      </TableCell>
                    )}
                    {visibleColumns.map(col => {
                      if (col.key === 'number')
                        return (
                          <TableCell key="number" className="font-medium text-[13px]">
                            {doc.number}
                            {doc.deletedAt && (
                              <Badge variant="destructive" className="ml-2 text-[10px] px-1 py-0">
                                видалено
                              </Badge>
                            )}
                          </TableCell>
                        );
                      if (col.key === 'type')
                        return (
                          <TableCell key="type">
                            <Badge
                              variant={STOCK_DOC_TYPE_BADGE[doc.type] ?? 'secondary'}
                              tooltip={STOCK_DOC_TYPE_DESCRIPTIONS[doc.type]}
                            >
                              {STOCK_DOC_TYPE_LABELS[doc.type]}
                            </Badge>
                          </TableCell>
                        );
                      if (col.key === 'warehouse')
                        return (
                          <TableCell key="warehouse" className="text-[13px] text-muted-foreground">
                            {doc.warehouseName ?? '—'}
                          </TableCell>
                        );
                      if (col.key === 'status')
                        return (
                          <TableCell key="status">
                            <Badge
                              variant={STOCK_DOC_STATUS_BADGE[doc.status] ?? 'secondary'}
                              tooltip={STOCK_DOC_STATUS_DESCRIPTIONS[doc.status]}
                            >
                              {STOCK_DOC_STATUS_LABELS[doc.status]}
                            </Badge>
                          </TableCell>
                        );
                      if (col.key === 'lines')
                        return (
                          <TableCell
                            key="lines"
                            className="text-right text-[13px] text-muted-foreground"
                          >
                            {doc.linesCount ?? doc.lines?.length ?? 0}
                          </TableCell>
                        );
                      if (col.key === 'date')
                        return (
                          <TableCell key="date" className="text-[13px] text-muted-foreground">
                            {doc.documentDate ? fmtDate(doc.documentDate) : fmtDate(doc.createdAt)}
                          </TableCell>
                        );
                      return null;
                    })}
                    <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Відкрити деталі"
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => void openDetailModal(doc)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        {!doc.deletedAt && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Позначити на видалення"
                            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                            onClick={() => void markDeleted(doc)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>

        {/* Bug #504: DetailPanel видалено — selectedDoc state ніколи не set non-null (Bug #496 paired-file pattern). */}
      </div>

      {/* Pagination */}
      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      {/* Create modal */}
      <StockDocumentCreateModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSaved={() => {
          setShowCreate(false);
          load();
        }}
      />

      {/* Edit modal */}
      <StockDocumentCreateModal
        open={!!editingDocId}
        stockDocumentId={editingDocId ?? undefined}
        onClose={() => setEditingDocId(null)}
        onSaved={() => {
          invalidate();
        }}
      />

      {/* Detail modal */}
      <Modal
        open={!!showDetail}
        onClose={() => setShowDetail(null)}
        title={showDetail ? `${STOCK_DOC_TYPE_LABELS[showDetail.type]} ${showDetail.number}` : ''}
        size="lg"
        footer={
          showDetail?.status === 'DRAFT' ? (
            <div className="flex gap-2 w-full">
              <Button
                onClick={() => handleTransition(showDetail, 'CONFIRMED')}
                loading={saving}
                className="flex-1"
              >
                Підтвердити документ
              </Button>
              <Button
                variant="destructive"
                onClick={() => handleTransition(showDetail, 'CANCELLED')}
                loading={saving}
              >
                Скасувати
              </Button>
            </div>
          ) : undefined
        }
      >
        {showDetail && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Badge
                variant={STOCK_DOC_TYPE_BADGE[showDetail.type] ?? 'secondary'}
                tooltip={STOCK_DOC_TYPE_DESCRIPTIONS[showDetail.type]}
              >
                {STOCK_DOC_TYPE_LABELS[showDetail.type]}
              </Badge>
              <Badge
                variant={STOCK_DOC_STATUS_BADGE[showDetail.status] ?? 'secondary'}
                tooltip={STOCK_DOC_STATUS_DESCRIPTIONS[showDetail.status]}
              >
                {STOCK_DOC_STATUS_LABELS[showDetail.status]}
              </Badge>
              <span className="text-muted-foreground text-sm">{showDetail.warehouseName}</span>
              {showDetail.targetWarehouseName && (
                <span className="text-foreground-faint text-sm">
                  → {showDetail.targetWarehouseName}
                </span>
              )}
            </div>

            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-secondary">
                  <tr>
                    <th className="text-left px-3 py-2 text-muted-foreground">Товар</th>
                    <th className="text-left px-3 py-2 text-muted-foreground">Артикул</th>
                    <th className="text-right px-3 py-2 text-muted-foreground">Кількість</th>
                    <th className="text-right px-3 py-2 text-muted-foreground">Ціна</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {showDetail.lines === undefined ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-2 text-center text-muted-foreground">
                        Завантаження…
                      </td>
                    </tr>
                  ) : (
                    showDetail.lines.map((l, i) => (
                      <tr key={l.id ?? i}>
                        <td className="px-3 py-2 text-foreground">{l.goodName}</td>
                        <td className="px-3 py-2 text-foreground-faint font-mono">
                          {l.goodSku ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-medium">
                          {l.quantity} {l.unitShortName ?? l.unit}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {l.price != null ? l.price.toFixed(2) + ' ₴' : '—'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {showDetail.notes && (
              <p className="text-sm text-muted-foreground italic">{showDetail.notes}</p>
            )}

            {showDetail.confirmedAt && (
              <p className="text-xs text-foreground-faint">
                Підтверджено: {fmtDateTime(showDetail.confirmedAt)}
              </p>
            )}
          </div>
        )}
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

export default function StockDocumentsPage() {
  return (
    <Suspense fallback={null}>
      <StockDocumentsPageClient />
    </Suspense>
  );
}
