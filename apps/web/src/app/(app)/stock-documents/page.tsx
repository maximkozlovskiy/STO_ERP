'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
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
  STOCK_DOC_STATUS_LABELS,
  STOCK_DOC_STATUS_BADGE,
} from '@sto/shared';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pagination } from '@/components/ui/pagination';
import { useConfirm } from '@/hooks/useConfirm';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { StockDocumentCreateModal } from '@/components/ui/StockDocumentCreateModal';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { DetailPanel, PanelField, type DetailPanelTab } from '@/components/ui/detail-panel';
import {
  STOCK_DOC_PANEL_SCHEMA,
  buildPanelFields,
  schemaToPanelConfigFields,
} from '@/lib/panel-schema';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
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
  branchName?: string;
  warehouseId: string;
  warehouseName?: string;
  targetWarehouseId?: string | null;
  targetWarehouseName?: string | null;
  notes: string | null;
  confirmedAt: string | null;
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

// Type/status/badge constants imported from @sto/shared
const TYPE_LABELS = STOCK_DOC_TYPE_LABELS;
const TYPE_BADGE = STOCK_DOC_TYPE_BADGE;
const STATUS_LABELS = STOCK_DOC_STATUS_LABELS;
const STATUS_BADGE = STOCK_DOC_STATUS_BADGE;

export default function StockDocumentsPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'STOREKEEPER']);

  const { confirm, dialogProps } = useConfirm();

  const COLUMNS = useMemo(
    () => [
      { key: 'number', label: 'Номер' },
      { key: 'type', label: 'Тип' },
      { key: 'warehouse', label: 'Склад' },
      { key: 'status', label: 'Статус' },
      { key: 'lines', label: 'Позицій' },
      { key: 'date', label: 'Дата документа' },
    ],
    [],
  );

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
    detailPanel,
    panelConfig,
    savedFilters: { saved: savedFilters, save: saveFilter, remove: removeFilter },
    features,
    limit,
  } = useListPage<StockDocFilters>('stock-documents', COLUMNS, { defaultLimit: 20 });

  // Local filter state (specific to stock-documents)
  const [typeFilter, setTypeFilter] = useState('');
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
  const [error, setError] = useState('');

  const [selectedDoc, setSelectedDoc] = useState<StockDoc | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showDetail, setShowDetail] = useState<StockDoc | null>(null);

  // Lazy-fetch full doc with lines when opening the DetailPanel.
  // List endpoint omits `lines` (perf: -20K line rows per page). Pattern mirrors
  // invoices/page.tsx selectInvoice — paint summary instantly, then upgrade
  // via GET /stock-documents/:id which includes lines + good + UoM.
  const selectDoc = useCallback(async (doc: StockDoc) => {
    setSelectedDoc(doc);
    try {
      const detail = await apiFetch<StockDoc>(`/stock-documents/${doc.id}`);
      setSelectedDoc(prev => (prev?.id === doc.id ? detail : prev));
    } catch {
      // keep basic doc data if detail fetch fails — UI shows empty lines list
    }
  }, []);

  const toggleSelectDoc = useCallback(
    (doc: StockDoc) => {
      setSelectedDoc(prev => {
        if (prev?.id === doc.id) return null;
        // Async upgrade — kicked off after returning the basic doc.
        void selectDoc(doc);
        return doc;
      });
    },
    [selectDoc],
  );

  // Open the standalone detail Modal (FSM buttons, full table). Same lazy-fetch
  // pattern as selectDoc — list response no longer carries lines.
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
    [setShowDeleted, resetPage, setActiveSavedFilterId],
  );

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = saveFilter(name, { typeFilter, statusFilter, showDeleted, dateFrom, dateTo });
      setActiveSavedFilterId(preset.id);
      if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
    },
    [saveFilter, typeFilter, statusFilter, showDeleted, dateFrom, dateTo, features.toastEnabled],
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
  const load = invalidate;

  const handleTransition = async (doc: StockDoc, newStatus: string) => {
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
  };

  const markDeleted = async (doc: StockDoc) => {
    if (
      !(await confirm({
        title: `Позначити документ ${doc.number} на видалення?`,
        variant: 'destructive',
      }))
    )
      return;
    try {
      await apiFetch(`/stock-documents/${doc.id}`, { method: 'DELETE' });
      if (selectedDoc?.id === doc.id) setSelectedDoc(null);
      load();
      toast.success('Документ позначено на видалення');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Помилка видалення');
    }
  };

  const types = ['', 'WRITEOFF', 'TRANSFER', 'OPENING_BALANCE'];
  const statuses = ['', 'DRAFT', 'CONFIRMED', 'CANCELLED'];

  const buildDocTabs = (doc: StockDoc): DetailPanelTab[] => [
    {
      key: 'info',
      label: 'Основне',
      content: (
        <div className="space-y-3">
          {buildPanelFields(doc as any, STOCK_DOC_PANEL_SCHEMA as any, panelConfig.config, {
            type: v => (
              <Badge variant={TYPE_BADGE[String(v)] ?? 'secondary'}>{TYPE_LABELS[String(v)]}</Badge>
            ),
            status: v => (
              <Badge variant={STATUS_BADGE[String(v)] ?? 'secondary'}>
                {STATUS_LABELS[String(v)]}
              </Badge>
            ),
          }).map(f => (
            <PanelField
              key={f.key}
              fieldKey={f.key}
              label={f.label}
              value={f.value}
              hidden={f.hidden}
            />
          ))}
        </div>
      ),
    },
    {
      key: 'lines',
      label: 'Позиції',
      content:
        // List endpoint omits `lines` (perf: 20 docs × 1000 line rows). Lines load
        // lazily via selectDoc() → GET /stock-documents/:id when the user opens the panel.
        // While the detail fetch is in flight, show a loading hint; otherwise render the list.
        doc.lines === undefined ? (
          <p className="text-[13px] text-muted-foreground">Завантаження позицій…</p>
        ) : doc.lines.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Немає позицій</p>
        ) : (
          <div className="space-y-2">
            {doc.lines.map((line, i) => (
              <div
                key={line.id ?? i}
                className="rounded-lg border border-border px-3 py-2 text-[13px]"
              >
                <p className="font-medium text-foreground">{line.goodName ?? line.goodId}</p>
                {line.goodSku && (
                  <p className="text-muted-foreground text-[12px]">{line.goodSku}</p>
                )}
                <p className="text-muted-foreground text-[12px] mt-0.5">
                  К-сть: <span className="text-foreground">{line.quantity}</span>
                  {line.price != null && <> · {fmtMoney(line.price)} ₴</>}
                </p>
              </div>
            ))}
          </div>
        ),
    },
  ];

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

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 shrink-0">
        {/* Type filters */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide mr-1">
            Тип
          </span>
          {types.map(t => (
            <button
              key={t}
              onClick={() => {
                setTypeFilter(t);
                resetPage();
                setActiveSavedFilterId(null);
              }}
              className={cn(
                'px-3 py-1 rounded-full text-sm font-medium border transition-colors',
                typeFilter === t
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground bg-surface hover:bg-secondary',
              )}
            >
              {t ? TYPE_LABELS[t] : 'Всі'}
            </button>
          ))}
        </div>
        {/* Divider */}
        <div className="h-6 w-px bg-border" />
        {/* Status filters */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide mr-1">
            Статус
          </span>
          {statuses.map(s => (
            <button
              key={s}
              onClick={() => {
                setStatusFilter(s);
                resetPage();
                setActiveSavedFilterId(null);
              }}
              className={cn(
                'px-3 py-1 rounded-full text-sm font-medium border transition-colors',
                statusFilter === s
                  ? 'bg-foreground text-primary-foreground border-foreground'
                  : 'border-border text-muted-foreground bg-surface hover:bg-secondary',
              )}
            >
              {s ? STATUS_LABELS[s] : 'Всі'}
            </button>
          ))}
        </div>
        <DatePickerInput
          value={dateFrom}
          onChange={v => {
            setDateFrom(v);
            resetPage();
            setActiveSavedFilterId(null);
          }}
          placeholder="Від"
          max={dateTo || undefined}
          className="w-36"
        />
        <DatePickerInput
          value={dateTo}
          onChange={v => {
            setDateTo(v);
            resetPage();
            setActiveSavedFilterId(null);
          }}
          placeholder="До"
          min={dateFrom || undefined}
          className="w-36"
        />
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
              JSON.stringify(order) !== JSON.stringify(COLUMNS.map(c => c.key)) ||
              Object.keys(customLabels).length > 0
            }
          />
          <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
          <Button onClick={() => setShowCreate(true)} leftIcon={<Plus className="h-4 w-4" />}>
            Документ
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
                      'group transition-colors',
                      detailPanel.enabled && 'cursor-pointer',
                      selectedDoc?.id === doc.id && detailPanel.enabled && 'bg-secondary',
                      bulkSelect.isSelected(doc.id) && 'bg-primary/5',
                      doc.deletedAt && 'opacity-60',
                    )}
                    onClick={() => {
                      if (detailPanel.enabled) toggleSelectDoc(doc);
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
                            <Badge variant={TYPE_BADGE[doc.type] ?? 'secondary'}>
                              {TYPE_LABELS[doc.type]}
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
                            <Badge variant={STATUS_BADGE[doc.status] ?? 'secondary'}>
                              {STATUS_LABELS[doc.status]}
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

        {/* Detail panel */}
        <DetailPanel
          open={!!selectedDoc && detailPanel.enabled}
          onClose={() => setSelectedDoc(null)}
          title={selectedDoc?.number ?? ''}
          subtitle={selectedDoc ? TYPE_LABELS[selectedDoc.type] : undefined}
          tabs={selectedDoc ? buildDocTabs(selectedDoc) : undefined}
          configFields={schemaToPanelConfigFields(
            STOCK_DOC_PANEL_SCHEMA as any,
            panelConfig.config,
          )}
          onToggleField={panelConfig.toggleField}
          onReorderFields={panelConfig.reorderFields}
          onReset={panelConfig.reset}
        />
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

      {/* Detail modal */}
      <Modal
        open={!!showDetail}
        onClose={() => setShowDetail(null)}
        title={showDetail ? `${TYPE_LABELS[showDetail.type]} ${showDetail.number}` : ''}
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
              <Badge variant={TYPE_BADGE[showDetail.type] ?? 'secondary'}>
                {TYPE_LABELS[showDetail.type]}
              </Badge>
              <Badge variant={STATUS_BADGE[showDetail.status] ?? 'secondary'}>
                {STATUS_LABELS[showDetail.status]}
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
                      <tr key={i}>
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
