'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Plus, FileText, Eye, EyeOff, Trash2 } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchCombobox } from '@/components/ui/search-combobox';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { DetailPanel, PanelField, type DetailPanelTab } from '@/components/ui/detail-panel';
import { useDetailPanel } from '@/hooks/useDetailPanel';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { SavedFiltersBar } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useTableColumns } from '@/hooks/useTableColumns';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface Branch { id: string; name: string; }
interface Warehouse { id: string; name: string; isMain: boolean; }
interface Good { id: string; name: string; sku: string | null; unit: string; }
interface DocLine {
  id?: string; goodId: string; goodName?: string; goodSku?: string | null;
  unit?: string; quantity: number; price: number | null;
}
interface StockDoc {
  id: string; number: string; type: string; status: string;
  branchId: string; branchName?: string;
  warehouseId: string; warehouseName?: string;
  targetWarehouseId?: string | null; targetWarehouseName?: string | null;
  notes: string | null; confirmedAt: string | null;
  lines: DocLine[];
  createdAt: string; updatedAt: string;
  deletedAt?: string | null;
}
interface Paginated { items: StockDoc[]; total: number; page: number; limit: number; }

interface StockDocFilters extends Record<string, unknown> {
  typeFilter: string;
  statusFilter: string;
  showDeleted: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  WRITEOFF: 'Списання', TRANSFER: 'Переміщення', OPENING_BALANCE: 'Поч. залишки',
};
const TYPE_BADGE: Record<string, BadgeVariant> = {
  WRITEOFF: 'destructive', TRANSFER: 'default', OPENING_BALANCE: 'secondary',
};
const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка', CONFIRMED: 'Підтверджено', CANCELLED: 'Скасовано',
};
const STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary', CONFIRMED: 'success', CANCELLED: 'destructive',
};

export default function StockDocumentsPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'STOREKEEPER']);

  const { confirm, dialogProps } = useConfirm();
  const features = useUiFeatures();

  const COLUMNS = useMemo(() => [
    { key: 'number',    label: 'Номер' },
    { key: 'type',      label: 'Тип' },
    { key: 'warehouse', label: 'Склад' },
    { key: 'status',    label: 'Статус' },
    { key: 'lines',     label: 'Позицій' },
    { key: 'date',      label: 'Дата' },
  ], []);

  const { visibleKeys: colVisible, toggle: toggleCol } = useTableColumns('stock-documents', COLUMNS);

  const detailPanel = useDetailPanel('stock-documents');

  const [docs, setDocs] = useState<StockDoc[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedDoc, setSelectedDoc] = useState<StockDoc | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showDetail, setShowDetail] = useState<StockDoc | null>(null);

  const [branches, setBranches] = useState<Branch[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [form, setForm] = useState({
    type: 'WRITEOFF', branchId: '', warehouseId: '', targetWarehouseId: '', notes: '',
  });
  const [lines, setLines] = useState<{ goodId: string; goodName: string; quantity: string; price: string }[]>([]);
  const [saving, setSaving] = useState(false);

  // — Saved filters ——————————————————————————————————————————————————————
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const { saved: savedFilters, save: saveFilter, remove: removeFilter } = useSavedFilters<StockDocFilters>('stock-documents');

  const applyFilter = useCallback((preset: { id: string; filters: StockDocFilters }) => {
    setTypeFilter(preset.filters.typeFilter ?? '');
    setStatusFilter(preset.filters.statusFilter ?? '');
    setShowDeleted(preset.filters.showDeleted ?? false);
    setPage(1);
    setActiveSavedFilterId(preset.id);
  }, []);

  const handleSaveFilter = useCallback((name: string) => {
    const preset = saveFilter(name, { typeFilter, statusFilter, showDeleted });
    setActiveSavedFilterId(preset.id);
    if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
  }, [saveFilter, typeFilter, statusFilter, showDeleted, features.toastEnabled]);

  // — Bulk select ————————————————————————————————————————————————————————
  const bulkSelect = useBulkSelect(docs);

  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
  }, [bulkSelect.someSelected]);

  const handleBulkDelete = useCallback(async (ids: string[]) => {
    if (!(await confirm({ title: `Видалити ${ids.length} документ(ів)?`, confirmLabel: 'Видалити', variant: 'destructive' }))) return;
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkSelect, confirm, features.toastEnabled]);

  const bulkActions = useMemo<BulkAction[]>(() => [
    {
      id: 'delete',
      label: 'Видалити вибрані',
      variant: 'destructive',
      icon: <Trash2 className="h-3.5 w-3.5 mr-1.5" />,
      onClick: handleBulkDelete,
    },
  ], [handleBulkDelete]);

  // — Unsaved guard ——————————————————————————————————————————————————————
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (typeFilter) params.set('type', typeFilter);
      if (statusFilter) params.set('status', statusFilter);
      if (showDeleted) params.set('showDeleted', 'true');
      const data = await apiFetch<Paginated>(`/stock-documents?${params}`);
      setDocs(data.items);
      setTotal(data.total);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження');
    } finally {
      setLoading(false);
    }
  }, [page, typeFilter, statusFilter, showDeleted]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!showCreate) return;
    let cancelled = false;

    // Apply branches + warehouses to state and auto-select sensible defaults.
    const apply = (bList: Branch[], wList: Warehouse[]) => {
      if (cancelled) return;
      setBranches(bList);
      setWarehouses(wList);
      // Auto-select defaults only if user hasn't already picked one — avoids
      // overriding manual choice if modal re-opens during a slow fetch, and
      // also collapses two sequential setForm calls into one render-safe update.
      setForm(f => {
        const next = { ...f };
        if (!next.branchId && bList.length === 1) next.branchId = bList[0].id;
        const mainW = wList.find(x => x.isMain) ?? (wList.length === 1 ? wList[0] : null);
        if (!next.warehouseId && mainW) next.warehouseId = mainW.id;
        return next;
      });
    };

    // Reference data — paint instantly from sessionStorage if cached.
    const cachedB = getCached<Branch[]>('cache:branches');
    const cachedW = getCached<Warehouse[]>('cache:warehouses');
    if (cachedB && cachedW) apply(cachedB, cachedW);

    // Always refresh in the background (parallel) to keep cache up to date.
    Promise.all([
      apiFetch<Branch[] | { items: Branch[] }>('/branches'),
      apiFetch<Warehouse[] | { items: Warehouse[] }>('/warehouses'),
    ]).then(([b, w]) => {
      const bList = Array.isArray(b) ? b : b.items;
      const wList = Array.isArray(w) ? w : w.items;
      setCache('cache:branches', bList);
      setCache('cache:warehouses', wList);
      apply(bList, wList);
    }).catch((e: unknown) => {
      if (!cancelled && !cachedB) setError(e instanceof Error ? e.message : 'Помилка завантаження довідників');
    });

    return () => { cancelled = true; };
  }, [showCreate]);

  const handleCreate = async () => {
    const validLines = lines.filter(l => l.goodId);
    for (const l of validLines) {
      const qty = parseFloat(l.quantity);
      if (!Number.isFinite(qty) || qty <= 0) { setError('Вкажіть коректну кількість для всіх позицій'); return; }
    }
    setSaving(true);
    try {
      await apiFetch<StockDoc>('/stock-documents', {
        method: 'POST',
        body: JSON.stringify({
          type: form.type,
          branchId: form.branchId,
          warehouseId: form.warehouseId,
          targetWarehouseId: form.targetWarehouseId || undefined,
          notes: form.notes || undefined,
          lines: validLines.map(l => ({
            goodId: l.goodId,
            quantity: parseFloat(l.quantity),
            price: l.price ? parseFloat(l.price) : undefined,
          })),
        }),
      });
      dirty.resetDirty();
      setShowCreate(false);
      setForm({ type: 'WRITEOFF', branchId: '', warehouseId: '', targetWarehouseId: '', notes: '' });
      setLines([]);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally { setSaving(false); }
  };

  const handleCloseCreate = () => {
    if (!dirty.confirmClose()) return;
    dirty.resetDirty();
    setShowCreate(false);
  };

  const handleTransition = async (doc: StockDoc, newStatus: string) => {
    const label = newStatus === 'CONFIRMED' ? 'підтвердити' : 'скасувати';
    if (!(await confirm({ title: `Бажаєте ${label} документ ${doc.number}?` }))) return;
    setSaving(true);
    setError('');
    try {
      await apiFetch<StockDoc>(`/stock-documents/${doc.id}/transition`, {
        method: 'POST', body: JSON.stringify({ status: newStatus }),
      });
      setShowDetail(null);
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка зміни статусу'); }
    finally { setSaving(false); }
  };

  const addLine = () => setLines(l => [...l, { goodId: '', goodName: '', quantity: '1', price: '' }]);
  const updateLine = (i: number, field: string, value: string) =>
    setLines(l => l.map((x, idx) => idx === i ? { ...x, [field]: value } : x));
  const removeLine = (i: number) => setLines(l => l.filter((_, idx) => idx !== i));

  const types = ['', 'WRITEOFF', 'TRANSFER', 'OPENING_BALANCE'];
  const statuses = ['', 'DRAFT', 'CONFIRMED', 'CANCELLED'];

  const buildDocTabs = (doc: StockDoc): DetailPanelTab[] => [
    {
      key: 'info',
      label: 'Основне',
      content: (
        <div className="space-y-3">
          <PanelField label="Тип" value={<Badge variant={TYPE_BADGE[doc.type] ?? 'secondary'}>{TYPE_LABELS[doc.type]}</Badge>} />
          <PanelField label="Статус" value={<Badge variant={STATUS_BADGE[doc.status] ?? 'secondary'}>{STATUS_LABELS[doc.status]}</Badge>} />
          <PanelField label="Склад-джерело" value={doc.warehouseName} />
          {doc.targetWarehouseName && <PanelField label="Склад-призначення" value={doc.targetWarehouseName} />}
          <PanelField label="Філія" value={doc.branchName} />
          <PanelField label="Підтверджено" value={doc.confirmedAt ? new Date(doc.confirmedAt).toLocaleDateString('uk-UA') : undefined} />
          {doc.notes && <PanelField label="Нотатки" value={doc.notes} />}
        </div>
      ),
    },
    {
      key: 'lines',
      label: 'Позиції',
      content: !doc.lines || doc.lines.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Немає позицій</p>
      ) : (
        <div className="space-y-2">
          {doc.lines.map((line, i) => (
            <div key={line.id ?? i} className="rounded-lg border border-border px-3 py-2 text-[13px]">
              <p className="font-medium text-foreground">{line.goodName ?? line.goodId}</p>
              {line.goodSku && <p className="text-muted-foreground text-[12px]">{line.goodSku}</p>}
              <p className="text-muted-foreground text-[12px] mt-0.5">
                К-сть: <span className="text-foreground">{line.quantity}</span>
                {line.price != null && <> · {line.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</>}
              </p>
            </div>
          ))}
        </div>
      ),
    },
  ];

  return (
    <div className="page-container">
      {error && (
        <div className="mb-4 text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="page-header">
        <div>
          <h1 className="page-title">Складські документи</h1>
          <p className="page-subtitle">{total} документів</p>
        </div>
        <Button onClick={() => setShowCreate(true)} leftIcon={<Plus className="h-4 w-4" />}>
          Новий документ
        </Button>
      </div>

      {/* Saved filters */}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<StockDocFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          className="mb-3"
        />
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        {/* Type filters */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide mr-1">Тип</span>
          {types.map(t => (
            <button
              key={t}
              onClick={() => { setTypeFilter(t); setPage(1); setActiveSavedFilterId(null); }}
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
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide mr-1">Статус</span>
          {statuses.map(s => (
            <button
              key={s}
              onClick={() => { setStatusFilter(s); setPage(1); setActiveSavedFilterId(null); }}
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
        {/* Show deleted */}
        <button
          onClick={() => { setShowDeleted(v => !v); setPage(1); setActiveSavedFilterId(null); }}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
            showDeleted
              ? 'bg-destructive/10 text-destructive border-destructive/30'
              : 'border-border text-muted-foreground bg-surface hover:bg-secondary',
          )}
        >
          {showDeleted ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          Показати видалені
        </button>

        <div className="flex items-center gap-2 ml-auto">
          <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
          <ColumnsDropdown columns={COLUMNS} visibleKeys={colVisible} onToggle={toggleCol} />
        </div>
      </div>

      {/* Bulk actions */}
      {features.bulkActionsEnabled && bulkSelect.count > 0 && (
        <BulkActionsBar
          count={bulkSelect.count}
          selectedIds={Array.from(bulkSelect.selected)}
          actions={bulkActions}
          onClear={bulkSelect.clear}
          className="mb-3"
        />
      )}

      {/* Table + DetailPanel */}
      <div className="flex gap-0">
        <div className="flex-1 min-w-0 overflow-auto border border-border rounded-xl">
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
                {colVisible.has('number')    && <TableHead>Номер</TableHead>}
                {colVisible.has('type')      && <TableHead>Тип</TableHead>}
                {colVisible.has('warehouse') && <TableHead>Склад</TableHead>}
                {colVisible.has('status')    && <TableHead>Статус</TableHead>}
                {colVisible.has('lines')     && <TableHead className="text-right">Позицій</TableHead>}
                {colVisible.has('date')      && <TableHead>Дата</TableHead>}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={colVisible.size + (features.bulkActionsEnabled ? 2 : 1)} className="py-10 text-center">
                    <div className="flex justify-center"><Spinner size="md" /></div>
                  </TableCell>
                </TableRow>
              )}
              {!loading && docs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={colVisible.size + (features.bulkActionsEnabled ? 2 : 1)} className="p-0">
                    <EmptyState icon={FileText} title="Документів не знайдено" />
                  </TableCell>
                </TableRow>
              )}
              {!loading && docs.map(doc => (
                <TableRow
                  key={doc.id}
                  className={cn(
                    detailPanel.enabled && 'cursor-pointer',
                    'transition-colors',
                    selectedDoc?.id === doc.id && 'bg-secondary',
                    bulkSelect.isSelected(doc.id) && 'bg-primary/5',
                    doc.deletedAt && 'opacity-60',
                  )}
                  onClick={() => { if (detailPanel.enabled) setSelectedDoc(prev => prev?.id === doc.id ? null : doc); }}
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
                  {colVisible.has('number') && (
                    <TableCell className="font-mono font-medium text-foreground">
                      {doc.number}
                      {doc.deletedAt && (
                        <Badge variant="destructive" className="ml-2 text-[10px] px-1 py-0">видалено</Badge>
                      )}
                    </TableCell>
                  )}
                  {colVisible.has('type') && (
                    <TableCell>
                      <Badge variant={TYPE_BADGE[doc.type] ?? 'secondary'}>
                        {TYPE_LABELS[doc.type]}
                      </Badge>
                    </TableCell>
                  )}
                  {colVisible.has('warehouse') && (
                    <TableCell className="text-foreground-muted">
                      {doc.warehouseName}
                      {doc.targetWarehouseName && <span className="text-muted-foreground"> → {doc.targetWarehouseName}</span>}
                    </TableCell>
                  )}
                  {colVisible.has('status') && (
                    <TableCell>
                      <Badge variant={STATUS_BADGE[doc.status] ?? 'secondary'}>
                        {STATUS_LABELS[doc.status]}
                      </Badge>
                    </TableCell>
                  )}
                  {colVisible.has('lines') && (
                    <TableCell className="text-right text-muted-foreground">{doc.lines.length}</TableCell>
                  )}
                  {colVisible.has('date') && (
                    <TableCell className="text-foreground-faint text-xs">{new Date(doc.createdAt).toLocaleDateString('uk-UA')}</TableCell>
                  )}
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={e => { e.stopPropagation(); setShowDetail(doc); }}
                    >
                      Деталі
                    </Button>
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
        />
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="flex justify-center gap-1.5 mt-4">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Назад</Button>
          <span className="h-8 w-8 flex items-center justify-center text-sm text-muted-foreground">{page}</span>
          <Button variant="outline" size="sm" disabled={page * limit >= total} onClick={() => setPage(p => p + 1)}>Вперед →</Button>
        </div>
      )}

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={handleCloseCreate}
        title="Новий складський документ"
        size="lg"
        footer={
          <Button
            onClick={handleCreate}
            loading={saving}
            disabled={!form.branchId || !form.warehouseId}
            className="w-full"
          >
            Створити документ
          </Button>
        }
      >
        <div className="space-y-4">
          <Select
            label="Тип документа"
            required
            value={form.type}
            onChange={e => { setForm(f => ({ ...f, type: e.target.value })); dirty.markDirty(); }}
          >
            <option value="WRITEOFF">Списання</option>
            <option value="TRANSFER">Переміщення між складами</option>
            <option value="OPENING_BALANCE">Початкові залишки</option>
          </Select>
          <Select
            label="Філія"
            required
            value={form.branchId}
            onChange={e => { setForm(f => ({ ...f, branchId: e.target.value })); dirty.markDirty(); }}
            placeholder="Оберіть філію"
          >
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
          <Select
            label={form.type === 'TRANSFER' ? 'Склад (джерело)' : 'Склад'}
            required
            value={form.warehouseId}
            onChange={e => { setForm(f => ({ ...f, warehouseId: e.target.value })); dirty.markDirty(); }}
            placeholder="Оберіть склад"
          >
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
          {form.type === 'TRANSFER' && (
            <Select
              label="Склад призначення"
              required
              value={form.targetWarehouseId}
              onChange={e => { setForm(f => ({ ...f, targetWarehouseId: e.target.value })); dirty.markDirty(); }}
              placeholder="Оберіть склад"
            >
              {warehouses.filter(w => w.id !== form.warehouseId).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          )}
          <Input
            label="Примітки"
            value={form.notes}
            onChange={e => { setForm(f => ({ ...f, notes: e.target.value })); dirty.markDirty(); }}
            placeholder="Необов'язково"
          />

          {/* Lines */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-foreground">Позиції</span>
              <Button variant="ghost" size="sm" onClick={addLine}>+ Додати</Button>
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <div className="flex-1">
                    <SearchCombobox<Good>
                      placeholder="Товар..."
                      value={l.goodId}
                      displayValue={l.goodName}
                      onSelect={g => { setLines(ls => ls.map((x, idx) => idx === i ? { ...x, goodId: g.id, goodName: g.name } : x)); dirty.markDirty(); }}
                      onClear={() => { setLines(ls => ls.map((x, idx) => idx === i ? { ...x, goodId: '', goodName: '' } : x)); dirty.markDirty(); }}
                      fetchItems={q => apiFetch<{ items: Good[] }>(`/goods?q=${encodeURIComponent(q)}&limit=10`).then(r => r.items.map(g => ({ ...g, primary: g.name, secondary: g.sku ?? undefined })))}
                    />
                  </div>
                  <Input
                    type="number"
                    value={l.quantity}
                    onChange={e => { updateLine(i, 'quantity', e.target.value); dirty.markDirty(); }}
                    placeholder="Кіл."
                    min="0.001"
                    step="0.001"
                    className="w-20 text-xs"
                  />
                  <Input
                    type="number"
                    value={l.price}
                    onChange={e => { updateLine(i, 'price', e.target.value); dirty.markDirty(); }}
                    placeholder="Ціна"
                    min="0"
                    step="0.01"
                    className="w-24 text-xs"
                  />
                  <button onClick={() => { removeLine(i); dirty.markDirty(); }} className="text-destructive/60 hover:text-destructive text-sm px-1">×</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Modal>

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
              <Badge variant={TYPE_BADGE[showDetail.type] ?? 'secondary'}>{TYPE_LABELS[showDetail.type]}</Badge>
              <Badge variant={STATUS_BADGE[showDetail.status] ?? 'secondary'}>{STATUS_LABELS[showDetail.status]}</Badge>
              <span className="text-muted-foreground text-sm">{showDetail.warehouseName}</span>
              {showDetail.targetWarehouseName && (
                <span className="text-foreground-faint text-sm">→ {showDetail.targetWarehouseName}</span>
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
                  {showDetail.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2 text-foreground">{l.goodName}</td>
                      <td className="px-3 py-2 text-foreground-faint font-mono">{l.goodSku ?? '—'}</td>
                      <td className="px-3 py-2 text-right font-medium">{l.quantity} {l.unit}</td>
                      <td className="px-3 py-2 text-right">{l.price != null ? l.price.toFixed(2) + ' ₴' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {showDetail.notes && (
              <p className="text-sm text-muted-foreground italic">{showDetail.notes}</p>
            )}

            {showDetail.confirmedAt && (
              <p className="text-xs text-foreground-faint">
                Підтверджено: {new Date(showDetail.confirmedAt).toLocaleString('uk-UA')}
              </p>
            )}
          </div>
        )}
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
