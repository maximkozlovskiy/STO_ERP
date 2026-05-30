'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { Plus, Pencil, Search, Trash2, BookOpen, Package, Layers, Star, Barcode, Ruler, Tag, X } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { Button } from '@/components/ui/button';
import { Modal, AnimatedBody } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { DetailPanel, PanelField, type DetailPanelTab } from '@/components/ui/detail-panel';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import { useDetailPanel } from '@/hooks/useDetailPanel';
import { XlsxImportButton } from '@/components/ui/xlsx-import-button';
import { BatchViewerModal } from '@/components/ui/batch-viewer-modal';
import { SavedFiltersBar } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import {
  DataTable, type DataTableColumn,
} from '@/components/ui/table';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useTableColumns } from '@/hooks/useTableColumns';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { toast } from '@/lib/toast';
import { ModalTabs } from '@/components/ui/modal-tabs';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Category { id: string; name: string; children: Category[]; }
interface Work { id: string; categoryId: string; categoryName: string; name: string; normoHours: number; price: number; description: string | null; isWarranty: boolean; }
interface PaginatedWorks { items: Work[]; total: number; page: number; limit: number; }
interface Brand { id: string; name: string; }
interface Unit { id: string; name: string; shortName: string; isSystem: boolean; coefficient: number; width?: number | null; height?: number | null; depth?: number | null; volume?: number | null; weight?: number | null; }
interface Good { id: string; sku: string | null; name: string; unit: string; unitId: string | null; purchasePrice: number | null; salePrice: number; category: string | null; barcode: string | null; brandId: string | null; notes: string | null; goodType?: string | null; preferredSupplierId?: string | null; preferredSupplierName?: string | null; }
interface Supplier { id: string; firstName: string | null; lastName: string | null; companyName: string | null; }
interface PaginatedGoods { items: Good[]; total: number; page: number; limit: number; }
interface ServiceWork { workId: string; workName: string; normoHours: number; price: number; quantity: number; }
interface ServiceGood { goodId: string; goodName: string; unit: string; salePrice: number; quantity: number; }
interface Service { id: string; name: string; description: string | null; price: number | null; works: ServiceWork[]; goods: ServiceGood[]; }
interface PaginatedServices { items: Service[]; total: number; page: number; limit: number; }
interface GoodBarcode { id: string; barcode: string; type: string; isPrimary: boolean; }
interface StockBatchDto {
  id: string; goodId: string; warehouseId: string;
  batchNumber: string | null; expiryDate: string | null;
  receivedQty: number; remainingQty: number;
  costPrice: number; salePrice: number;
  isActive: boolean; createdAt: string;
  purchaseOrderNumber: string | null;
  purchaseOrderLineId: string | null;
}

type Tab = 'works' | 'goods' | 'services' | 'units' | 'brands';
type GoodDetailTab = 'info' | 'barcodes' | 'batches';

interface WorksFilters extends Record<string, unknown> {
  search: string;
  categoryId: string;
}

interface GoodsFilters extends Record<string, unknown> {
  search: string;
}

interface ServicesFilters extends Record<string, unknown> {
  search: string;
}

const GOOD_TYPE_LABELS: Record<string, string> = {
  SPARE_PART: 'Запчастина',
  CONSUMABLE: 'Витратний матеріал',
  MATERIAL: 'Матеріал',
  TOOL: 'Інструмент',
};
const GOOD_TYPE_BADGE: Record<string, BadgeVariant> = {
  SPARE_PART: 'default',
  CONSUMABLE: 'secondary',
  MATERIAL: 'warning',
  TOOL: 'success',
};

function Pagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex justify-center gap-1.5 mt-4">
      {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
        <button key={p} onClick={() => onChange(p)}
          className={`h-8 w-8 rounded-lg text-[13px] font-medium border transition-colors ${
            p === page
              ? 'bg-primary text-primary-foreground border-primary'
              : 'border-border text-muted-foreground bg-surface hover:bg-secondary'
          }`}>
          {p}
        </button>
      ))}
    </div>
  );
}

// ─── Works Tab ───────────────────────────────────────────────────────────────

function WorksTab() {
  const { confirm, dialogProps } = useConfirm();
  const features = useUiFeatures();
  const detailPanel = useDetailPanel('catalog-works');
  const [categories, setCategories] = useState<Category[]>([]);
  const [works, setWorks] = useState<PaginatedWorks | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedCat, setSelectedCat] = useState('');
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q);
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ categoryId: '', name: '', normoHours: '', price: '', description: '', isWarranty: false });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [selectedWork, setSelectedWork] = useState<Work | null>(null);
  const [editWork, setEditWork] = useState<Work | null>(null);
  const [editForm, setEditForm] = useState({ categoryId: '', name: '', normoHours: '', price: '', description: '', isWarranty: false });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const WORKS_COLUMNS = useMemo(() => [
    { key: 'name', label: 'Назва', defaultVisible: true },
    { key: 'category', label: 'Категорія', defaultVisible: true },
    { key: 'normo', label: 'Нормо-год', defaultVisible: true },
    { key: 'price', label: 'Ціна, ₴', defaultVisible: true },
  ], []);

  const { visibleKeys: worksColVisible, visibleColumns: worksVisibleColumns, orderedColumns: worksOrderedColumns, order: worksOrder, customLabels: worksCustomLabels, toggle: toggleWorksCol, reorder: reorderWorks, renameColumn: renameWorksCol, resetConfig: resetWorksConfig } = useTableColumns('catalog-works', WORKS_COLUMNS);

  // ── Saved filters ────────────────────────────────────────────────────────────
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const { saved: savedFilters, save: saveFilter, remove: removeFilter } = useSavedFilters<WorksFilters>('catalog-works');

  const applyFilter = useCallback((preset: { id: string; filters: WorksFilters }) => {
    setQ(preset.filters.search ?? '');
    setSelectedCat(preset.filters.categoryId ?? '');
    setPage(1);
    setActiveSavedFilterId(preset.id);
  }, []);

  const handleSaveFilter = useCallback((name: string) => {
    const preset = saveFilter(name, { search: q, categoryId: selectedCat });
    setActiveSavedFilterId(preset.id);
    if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
  }, [saveFilter, q, selectedCat, features.toastEnabled]);

  // ── Bulk select ──────────────────────────────────────────────────────────────
  const bulkSelect = useBulkSelect(works?.items ?? []);

  // loadRef allows bulkDelete (defined before load) to call the latest load()
  const worksLoadRef = useRef<(() => void) | null>(null);

  const worksActions = useMemo<BulkAction[]>(() => [
    {
      id: 'delete', label: 'Видалити вибрані', variant: 'destructive',
      onClick: async (ids) => {
        if (!window.confirm(`Видалити ${ids.length} ${ids.length === 1 ? 'роботу' : 'робіт'}?`)) return;
        const results = await Promise.allSettled(
          ids.map(id => apiFetch(`/works/${id}`, { method: 'DELETE' })),
        );
        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.length - succeeded;
        bulkSelect.clear();
        worksLoadRef.current?.();
        if (features.toastEnabled) {
          if (failed === 0) toast.success(`Видалено ${succeeded} ${succeeded === 1 ? 'роботу' : 'робіт'}`);
          else toast.warning(`Видалено ${succeeded} з ${results.length}. ${failed} не вдалось`);
        }
      },
    },
  ], [bulkSelect, features.toastEnabled]);

  // ── Unsaved guard ────────────────────────────────────────────────────────────
  const worksFormDirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
  const editWorkDirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  useEffect(() => {
    // Reference data — paint instantly from sessionStorage, refresh in background.
    const cached = getCached<Category[]>('cache:work-categories');
    if (cached) setCategories(cached);
    apiFetch<Category[]>('/work-categories')
      .then(d => { setCategories(d); setCache('cache:work-categories', d); })
      .catch((e: unknown) => { if (!cached) setError(e instanceof Error ? e.message : 'Помилка завантаження категорій'); });
  }, []);

  // Sync categoryId when categories load after modal is already open (race condition fix)
  useEffect(() => {
    const first = flatCategories(categories)[0];
    if (!first) return;
    if (modal && !form.categoryId) setForm(f => ({ ...f, categoryId: first.id }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories, modal]);

  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), limit: '30' });
    if (selectedCat) p.set('categoryId', selectedCat);
    if (debouncedQ) p.set('q', debouncedQ);
    apiFetch<PaginatedWorks>(`/works?${p}`).then(setWorks).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження')).finally(() => setLoading(false));
  }, [page, selectedCat, debouncedQ]);

  // Keep ref in sync so worksActions can call load() without depending on it
  useEffect(() => { worksLoadRef.current = load; }, [load]);

  useEffect(() => { load(); }, [load]);

  const flatCategories = (cats: Category[], depth = 0): Array<Category & { depth: number }> =>
    cats.flatMap(c => [{ ...c, depth }, ...flatCategories(c.children, depth + 1)]);

  const create = async () => {
    const normo = Number(form.normoHours); const price = Number(form.price);
    if (!Number.isFinite(normo) || normo <= 0) { setError('Норма-годин повинна бути більше нуля'); return; }
    if (!Number.isFinite(price) || price < 0) { setError('Ціна повинна бути невід\'ємним числом'); return; }
    setSaving(true); setError('');
    try {
      await apiFetch<Work>('/works', {
        method: 'POST',
        body: JSON.stringify({
          categoryId: form.categoryId,
          name: form.name,
          normoHours: normo,
          price,
          description: form.description || undefined,
          isWarranty: form.isWarranty,
        }),
      });
      setModal(false);
      setForm({ categoryId: '', name: '', normoHours: '', price: '', description: '', isWarranty: false });
      worksFormDirty.resetDirty();
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!(await confirm({ title: 'Видалити роботу?', variant: 'destructive' }))) return;
    setDeletingId(id); setError('');
    try { await apiFetch<void>(`/works/${id}`, { method: 'DELETE' }); load(); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setDeletingId(null); }
  };

  const openEditWork = (w: Work) => {
    setEditWork(w);
    setEditForm({ categoryId: w.categoryId, name: w.name, normoHours: String(w.normoHours), price: String(w.price), description: w.description ?? '', isWarranty: w.isWarranty });
    setEditError('');
    editWorkDirty.resetDirty();
  };

  const saveEditWork = async () => {
    if (!editWork) return;
    const normo = Number(editForm.normoHours); const price = Number(editForm.price);
    if (!Number.isFinite(normo) || normo <= 0) { setEditError('Норма-годин повинна бути більше нуля'); return; }
    if (!Number.isFinite(price) || price < 0) { setEditError('Ціна повинна бути невід\'ємним числом'); return; }
    setEditSaving(true); setEditError('');
    try {
      await apiFetch<Work>(`/works/${editWork.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ categoryId: editForm.categoryId, name: editForm.name, normoHours: normo, price, description: editForm.description || undefined, isWarranty: editForm.isWarranty }),
      });
      editWorkDirty.resetDirty();
      setEditWork(null);
      load();
    } catch (e: unknown) { setEditError(e instanceof Error ? e.message : 'Помилка збереження'); }
    finally { setEditSaving(false); }
  };

  const flat = flatCategories(categories);
  const totalPages = works ? Math.ceil(works.total / works.limit) : 1;

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">{error}</div>
      )}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<WorksFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          className="mb-3"
        />
      )}

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input value={q} onChange={e => { setQ(e.target.value); setPage(1); setActiveSavedFilterId(null); }} placeholder="Пошук робіт..." className="pl-9" />
        </div>
        <Select value={selectedCat} onChange={e => { setSelectedCat(e.target.value); setPage(1); setActiveSavedFilterId(null); }}>
          <option value="">Всі категорії</option>
          {flat.map(c => <option key={c.id} value={c.id}>{' '.repeat(c.depth * 4)}{c.name}</option>)}
        </Select>
        <XlsxImportButton
          templateType="works"
          importUrl="/xlsx/import/works"
          onImportComplete={load}
        />
        <div className="flex items-center gap-2 ml-auto">
          <ColumnsDropdown
            columns={worksOrderedColumns}
            visibleKeys={worksColVisible}
            onToggle={toggleWorksCol}
            onReorder={reorderWorks}
            onRename={renameWorksCol}
            onReset={resetWorksConfig}
            hasCustomization={JSON.stringify(worksOrder) !== JSON.stringify(WORKS_COLUMNS.map(c=>c.key)) || Object.keys(worksCustomLabels).length > 0}
          />
          <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
        </div>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => { setForm({ categoryId: flat[0]?.id ?? '', name: '', normoHours: '', price: '', description: '', isWarranty: false }); worksFormDirty.resetDirty(); setError(''); setModal(true); }}>
          Робота
        </Button>
      </div>

      {features.bulkActionsEnabled && (
        <BulkActionsBar
          count={bulkSelect.count}
          selectedIds={[...bulkSelect.selected]}
          actions={worksActions}
          onClear={bulkSelect.clear}
          className="mb-3"
        />
      )}

      <div className="flex gap-0">
        <div className="flex-1 min-w-0 overflow-auto border border-border rounded-xl bg-surface">
          <DataTable
            columns={[
              ...worksVisibleColumns.map(col => ({ key: col.key, label: col.label }) satisfies DataTableColumn),
              { key: 'actions', label: '' },
            ]}
            rows={loading ? [] : (works?.items ?? []).map(w => ({
              id: w.id as string,
              name: (
                <>
                  <p className="text-[13px] font-medium text-foreground">{w.name}</p>
                  {w.isWarranty && <span className="text-[11px] text-success">Гарантійна</span>}
                  {w.description && <p className="text-[12px] text-muted-foreground mt-0.5">{w.description}</p>}
                </>
              ),
              category: <span className="text-[13px] text-muted-foreground">{w.categoryName}</span>,
              normo: <span className="text-[13px]">{w.normoHours}</span>,
              price: <span className="font-medium text-[13px]">{w.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}</span>,
              actions: (
                <div className="flex items-center justify-end gap-1">
                  <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); openEditWork(w); }}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={e => { e.stopPropagation(); remove(w.id); }}
                    disabled={deletingId === w.id}
                    loading={deletingId === w.id}
                    className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ),
            }))}
            onRowClick={row => { if (detailPanel.enabled) setSelectedWork(prev => prev?.id === row.id ? null : (works?.items.find(w => w.id === row.id) ?? null)); }}
            selectable={features.bulkActionsEnabled}
            selectedIds={bulkSelect.selected}
            onSelectRow={id => bulkSelect.toggle(id)}
            onSelectAll={bulkSelect.toggleAll}
            emptyText="Нічого не знайдено"
          />
          {loading && <div className="flex justify-center py-10"><Spinner size="md" /></div>}
        </div>

        {(() => {
          const buildWorkTabs = (w: Work): DetailPanelTab[] => [
            {
              key: 'info', label: 'Основне',
              content: (
                <div className="space-y-3">
                  <PanelField label="Категорія" value={w.categoryName} />
                  <PanelField label="Нормо-год" value={String(w.normoHours)} />
                  <PanelField label="Ціна" value={`${w.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴`} />
                  {w.isWarranty && <PanelField label="Гарантійна" value="Так" />}
                  {w.description && <PanelField label="Опис" value={w.description} />}
                </div>
              ),
            },
          ];
          return (
            <DetailPanel
              open={!!selectedWork && detailPanel.enabled}
              onClose={() => setSelectedWork(null)}
              title={selectedWork?.name ?? ''}
              tabs={selectedWork ? buildWorkTabs(selectedWork) : undefined}
            />
          );
        })()}
      </div>

      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      <Modal open={modal} onClose={async () => { if (!(await worksFormDirty.confirmClose())) return; setModal(false); }} title="Нова робота"
        footer={
          <Button onClick={create} loading={saving} disabled={!form.name || !form.categoryId || !form.normoHours || !form.price} className="w-full">
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">{error}</div>
        )}
        <div className="space-y-4">
          <Select
            label="Категорія"
            required
            value={form.categoryId}
            onChange={e => { setForm(f => ({ ...f, categoryId: e.target.value })); worksFormDirty.markDirty(); }}
          >
            {flat.map(c => <option key={c.id} value={c.id}>{' '.repeat(c.depth * 4)}{c.name}</option>)}
          </Select>
          <Input
            label="Назва"
            required
            value={form.name}
            onChange={e => { setForm(f => ({ ...f, name: e.target.value })); worksFormDirty.markDirty(); }}
            placeholder="Заміна масла"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Нормо-год"
              required
              type="number"
              value={form.normoHours}
              onChange={e => { setForm(f => ({ ...f, normoHours: e.target.value })); worksFormDirty.markDirty(); }}
              placeholder="1.5"
            />
            <Input
              label="Ціна, ₴"
              required
              type="number"
              value={form.price}
              onChange={e => { setForm(f => ({ ...f, price: e.target.value })); worksFormDirty.markDirty(); }}
              placeholder="500"
            />
          </div>
          <Input
            label="Опис"
            value={form.description}
            onChange={e => { setForm(f => ({ ...f, description: e.target.value })); worksFormDirty.markDirty(); }}
          />
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.isWarranty}
              onChange={e => { setForm(f => ({ ...f, isWarranty: e.target.checked })); worksFormDirty.markDirty(); }}
              className="h-4 w-4 accent-primary"
            />
            <span className="text-sm text-foreground">Гарантійна робота (виконується безкоштовно)</span>
          </label>
        </div>
      </Modal>

      <Modal open={!!editWork} onClose={async () => { if (!(await editWorkDirty.confirmClose())) return; setEditWork(null); }} title="Редагування роботи"
        footer={
          <>
            <Button onClick={saveEditWork} loading={editSaving} disabled={!editForm.name || !editForm.categoryId || !editForm.normoHours || !editForm.price}>
              Зберегти
            </Button>
            <Button variant="outline" onClick={async () => { if (!(await editWorkDirty.confirmClose())) return; setEditWork(null); }}>Скасувати</Button>
          </>
        }
      >
        {editError && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">{editError}</div>
        )}
        <div className="space-y-4">
          <Select
            label="Категорія"
            required
            value={editForm.categoryId}
            onChange={e => { setEditForm(f => ({ ...f, categoryId: e.target.value })); editWorkDirty.markDirty(); }}
          >
            {flat.map(c => <option key={c.id} value={c.id}>{' '.repeat(c.depth * 4)}{c.name}</option>)}
          </Select>
          <Input
            label="Назва"
            required
            value={editForm.name}
            onChange={e => { setEditForm(f => ({ ...f, name: e.target.value })); editWorkDirty.markDirty(); }}
            placeholder="Заміна масла"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Нормо-год"
              required
              type="number"
              value={editForm.normoHours}
              onChange={e => { setEditForm(f => ({ ...f, normoHours: e.target.value })); editWorkDirty.markDirty(); }}
              placeholder="1.5"
            />
            <Input
              label="Ціна, ₴"
              required
              type="number"
              value={editForm.price}
              onChange={e => { setEditForm(f => ({ ...f, price: e.target.value })); editWorkDirty.markDirty(); }}
              placeholder="500"
            />
          </div>
          <Input
            label="Опис"
            value={editForm.description}
            onChange={e => { setEditForm(f => ({ ...f, description: e.target.value })); editWorkDirty.markDirty(); }}
          />
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={editForm.isWarranty}
              onChange={e => { setEditForm(f => ({ ...f, isWarranty: e.target.checked })); editWorkDirty.markDirty(); }}
              className="h-4 w-4 accent-primary"
            />
            <span className="text-sm text-foreground">Гарантійна робота (виконується безкоштовно)</span>
          </label>
        </div>
      </Modal>
      <DirtyConfirmDialog {...worksFormDirty.dialogProps} />
      <DirtyConfirmDialog {...editWorkDirty.dialogProps} />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

// ─── Goods Tab ────────────────────────────────────────────────────────────────

function GoodsTab() {
  const { confirm, dialogProps } = useConfirm();
  const features = useUiFeatures();
  const detailPanel = useDetailPanel('catalog-goods');
  const [goods, setGoods] = useState<PaginatedGoods | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q);
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ sku: '', name: '', unit: 'шт', unitId: '', purchasePrice: '', salePrice: '', category: '', brandId: '', barcode: '', notes: '', goodType: '', preferredSupplierId: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [selectedGood, setSelectedGood] = useState<Good | null>(null);
  const [goodDetailTab, setGoodDetailTab] = useState<GoodDetailTab>('info');
  const [barcodes, setBarcodes] = useState<GoodBarcode[]>([]);
  const [barcodesLoading, setBarcodesLoading] = useState(false);
  const [newBarcode, setNewBarcode] = useState('');
  const [newBarcodeType, setNewBarcodeType] = useState('EAN13');
  const [addingBarcode, setAddingBarcode] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editGood, setEditGood] = useState<Good | null>(null);
  const [editGoodForm, setEditGoodForm] = useState({ sku: '', name: '', unit: 'шт', unitId: '', purchasePrice: '', salePrice: '', category: '', brandId: '', notes: '', goodType: '', preferredSupplierId: '' });
  const [editGoodSaving, setEditGoodSaving] = useState(false);
  const [editGoodError, setEditGoodError] = useState('');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [batchViewerGoodId, setBatchViewerGoodId] = useState<string | null>(null);

  // ── Edit modal: barcodes tab ─────────────────────────────────────────────────
  const [modalBarcodes, setModalBarcodes] = useState<GoodBarcode[]>([]);
  const [modalBarcodesLoading, setModalBarcodesLoading] = useState(false);
  const [barcodeError, setBarcodeError] = useState('');
  const [showAddBarcode, setShowAddBarcode] = useState(false);
  const [addBarcodeForm, setAddBarcodeForm] = useState({ barcode: '', type: 'EAN13' });
  const [addingBarcode2, setAddingBarcode2] = useState(false);
  const [deletingBarcodeId2, setDeletingBarcodeId2] = useState<string | null>(null);
  const modalBarcodeReqRef = useRef(0);

  // ── Edit modal: batches tab ──────────────────────────────────────────────────
  const [modalBatches, setModalBatches] = useState<StockBatchDto[]>([]);
  const [modalBatchesLoading, setModalBatchesLoading] = useState(false);
  const [batchError, setBatchError] = useState('');
  const modalBatchReqRef = useRef(0);

  const GOODS_COLUMNS = useMemo(() => [
    { key: 'name', label: 'Назва / Артикул', defaultVisible: true },
    { key: 'category', label: 'Категорія', defaultVisible: true },
    { key: 'unit', label: 'Одиниця', defaultVisible: false },
    { key: 'purchase', label: 'Закупівля, ₴', defaultVisible: true },
    { key: 'sale', label: 'Продаж, ₴', defaultVisible: true },
  ], []);

  const { visibleKeys: goodsColVisible, visibleColumns: goodsVisibleColumns, orderedColumns: goodsOrderedColumns, order: goodsOrder, customLabels: goodsCustomLabels, toggle: toggleGoodsCol, reorder: reorderGoods, renameColumn: renameGoodsCol, resetConfig: resetGoodsConfig } = useTableColumns('catalog-goods', GOODS_COLUMNS);

  // ── Saved filters ────────────────────────────────────────────────────────────
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const { saved: savedFilters, save: saveFilter, remove: removeFilter } = useSavedFilters<GoodsFilters>('catalog-goods');

  const applyFilter = useCallback((preset: { id: string; filters: GoodsFilters }) => {
    setQ(preset.filters.search ?? '');
    setPage(1);
    setActiveSavedFilterId(preset.id);
  }, []);

  const handleSaveFilter = useCallback((name: string) => {
    const preset = saveFilter(name, { search: q });
    setActiveSavedFilterId(preset.id);
    if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
  }, [saveFilter, q, features.toastEnabled]);

  // ── Bulk select ──────────────────────────────────────────────────────────────
  const bulkSelect = useBulkSelect(goods?.items ?? []);

  const goodsLoadRef = useRef<(() => void) | null>(null);

  const goodsActions = useMemo<BulkAction[]>(() => [
    {
      id: 'delete', label: 'Видалити вибрані', variant: 'destructive',
      onClick: async (ids) => {
        if (!window.confirm(`Видалити ${ids.length} ${ids.length === 1 ? 'товар' : 'товарів'}?`)) return;
        const results = await Promise.allSettled(
          ids.map(id => apiFetch(`/goods/${id}`, { method: 'DELETE' })),
        );
        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.length - succeeded;
        bulkSelect.clear();
        goodsLoadRef.current?.();
        if (features.toastEnabled) {
          if (failed === 0) toast.success(`Видалено ${succeeded} ${succeeded === 1 ? 'товар' : 'товарів'}`);
          else toast.warning(`Видалено ${succeeded} з ${results.length}. ${failed} не вдалось`);
        }
      },
    },
  ], [bulkSelect, features.toastEnabled]);

  // ── Unsaved guard ────────────────────────────────────────────────────────────
  const goodsFormDirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
  const editGoodDirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  useEffect(() => {
    // Reference data (brands, units, suppliers) — paint instantly from
    // sessionStorage, then refresh all three in parallel.
    const cBrands = getCached<Brand[]>('cache:brands');
    const cUnits = getCached<Unit[]>('cache:units');
    const cSuppliers = getCached<Supplier[]>('cache:suppliers');
    if (cBrands) setBrands(cBrands);
    if (cUnits) setUnits(cUnits);
    if (cSuppliers) setSuppliers(cSuppliers);

    Promise.all([
      apiFetch<{ items: Brand[]; total: number }>('/brands?limit=200').catch(() => ({ items: [], total: 0 })),
      apiFetch<Unit[]>('/units').catch(() => [] as Unit[]),
      apiFetch<{ items: Supplier[] }>('/counterparties?types=SUPPLIER,BOTH&limit=200').catch(() => ({ items: [] as Supplier[] })),
    ]).then(([brandsRes, unitsRes, suppliersRes]) => {
      setBrands(brandsRes.items);
      setCache('cache:brands', brandsRes.items);
      setUnits(unitsRes);
      setCache('cache:units', unitsRes);
      setSuppliers(suppliersRes.items);
      setCache('cache:suppliers', suppliersRes.items);
    });
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), limit: '30' });
    if (debouncedQ) p.set('q', debouncedQ);
    apiFetch<PaginatedGoods>(`/goods?${p}`).then(setGoods).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження')).finally(() => setLoading(false));
  }, [page, debouncedQ]);

  // Keep ref in sync so goodsActions can call load() without depending on it
  useEffect(() => { goodsLoadRef.current = load; }, [load]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    const salePrice = Number(form.salePrice);
    if (!Number.isFinite(salePrice) || salePrice < 0) { setError('Ціна продажу повинна бути невід\'ємним числом'); return; }
    if (form.purchasePrice) {
      const pp = Number(form.purchasePrice);
      if (!Number.isFinite(pp) || pp < 0) { setError('Ціна закупівлі повинна бути невід\'ємним числом'); return; }
    }
    setSaving(true); setError('');
    try {
      await apiFetch<Good>('/goods', {
        method: 'POST',
        body: JSON.stringify({
          sku: form.sku || undefined,
          name: form.name,
          unit: form.unit || 'шт',
          unitId: form.unitId || undefined,
          purchasePrice: form.purchasePrice ? Number(form.purchasePrice) : undefined,
          salePrice,
          category: form.category || undefined,
          brandId: form.brandId || undefined,
          barcode: form.barcode || undefined,
          notes: form.notes || undefined,
          goodType: form.goodType || undefined,
          preferredSupplierId: form.preferredSupplierId || undefined,
        }),
      });
      setModal(false);
      setForm({ sku: '', name: '', unit: 'шт', unitId: '', purchasePrice: '', salePrice: '', category: '', brandId: '', barcode: '', notes: '', goodType: '', preferredSupplierId: '' });
      goodsFormDirty.resetDirty();
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const loadBarcodes = useCallback((goodId: string) => {
    setBarcodesLoading(true);
    apiFetch<GoodBarcode[]>(`/goods/${goodId}/barcodes`)
      .then(setBarcodes)
      .catch(() => setBarcodes([]))
      .finally(() => setBarcodesLoading(false));
  }, []);

  const addBarcode = async (goodId: string) => {
    if (!newBarcode.trim()) return;
    setAddingBarcode(true);
    try {
      await apiFetch<GoodBarcode>(`/goods/${goodId}/barcodes`, {
        method: 'POST',
        body: JSON.stringify({ barcode: newBarcode.trim(), type: newBarcodeType }),
      });
      setNewBarcode('');
      loadBarcodes(goodId);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка додавання штрихкоду'); }
    finally { setAddingBarcode(false); }
  };

  const deleteBarcode = async (goodId: string, barcodeId: string) => {
    if (!(await confirm({ title: 'Видалити штрихкод?', variant: 'destructive' }))) return;
    try {
      await apiFetch<void>(`/goods/${goodId}/barcodes/${barcodeId}`, { method: 'DELETE' });
      loadBarcodes(goodId);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення штрихкоду'); }
  };

  const markForDeletion = async (id: string) => {
    setSaving(true); setError('');
    try {
      await apiFetch<void>(`/goods/${id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      if (selectedGood?.id === id) setSelectedGood(null);
      load();
    }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setSaving(false); }
  };

  const selectGood = (g: Good | null) => {
    setSelectedGood(g);
    setGoodDetailTab('info');
    if (g) loadBarcodes(g.id);
  };

  const openEditGood = (g: Good) => {
    setEditGood(g);
    setEditGoodForm({
      sku: g.sku ?? '', name: g.name, unit: g.unit, unitId: g.unitId ?? '',
      purchasePrice: g.purchasePrice != null ? String(g.purchasePrice) : '',
      salePrice: String(g.salePrice), category: g.category ?? '',
      brandId: g.brandId ?? '', notes: g.notes ?? '', goodType: g.goodType ?? '',
      preferredSupplierId: g.preferredSupplierId ?? '',
    });
    setEditGoodError('');
    editGoodDirty.resetDirty();
    // Reset tabs state
    setModalBarcodes([]);
    setBarcodeError('');
    setShowAddBarcode(false);
    setAddBarcodeForm({ barcode: '', type: 'EAN13' });
    setModalBatches([]);
    setBatchError('');

    // Race-guarded fetch for barcodes and batches
    const bReqId = ++modalBarcodeReqRef.current;
    const btReqId = ++modalBatchReqRef.current;

    setModalBarcodesLoading(true);
    apiFetch<GoodBarcode[]>(`/goods/${g.id}/barcodes`)
      .then(data => { if (modalBarcodeReqRef.current === bReqId) setModalBarcodes(data); })
      .catch(err => { if (modalBarcodeReqRef.current === bReqId) setBarcodeError(err instanceof Error ? err.message : 'Помилка завантаження штрихкодів'); })
      .finally(() => { if (modalBarcodeReqRef.current === bReqId) setModalBarcodesLoading(false); });

    setModalBatchesLoading(true);
    apiFetch<{ items: StockBatchDto[]; total: number }>(`/goods/${g.id}/batches`)
      .then(data => { if (modalBatchReqRef.current === btReqId) setModalBatches(data.items); })
      .catch(err => { if (modalBatchReqRef.current === btReqId) setBatchError(err instanceof Error ? err.message : 'Помилка завантаження партій'); })
      .finally(() => { if (modalBatchReqRef.current === btReqId) setModalBatchesLoading(false); });
  };

  const saveEditGood = async () => {
    if (!editGood) return;
    const salePrice = Number(editGoodForm.salePrice);
    if (!Number.isFinite(salePrice) || salePrice < 0) { setEditGoodError('Ціна продажу повинна бути невід\'ємним числом'); return; }
    setEditGoodSaving(true); setEditGoodError('');
    try {
      await apiFetch<Good>(`/goods/${editGood.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          sku: editGoodForm.sku || undefined,
          name: editGoodForm.name,
          unit: editGoodForm.unit || 'шт',
          unitId: editGoodForm.unitId || undefined,
          purchasePrice: editGoodForm.purchasePrice ? Number(editGoodForm.purchasePrice) : undefined,
          salePrice,
          category: editGoodForm.category || undefined,
          brandId: editGoodForm.brandId || undefined,
          notes: editGoodForm.notes || undefined,
          goodType: editGoodForm.goodType || undefined,
          preferredSupplierId: editGoodForm.preferredSupplierId || undefined,
        }),
      });
      editGoodDirty.resetDirty();
      setEditGood(null);
      load();
    } catch (e: unknown) { setEditGoodError(e instanceof Error ? e.message : 'Помилка збереження'); }
    finally { setEditGoodSaving(false); }
  };

  const totalPages = goods ? Math.ceil(goods.total / goods.limit) : 1;

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">{error}</div>
      )}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<GoodsFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          className="mb-3"
        />
      )}

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input value={q} onChange={e => { setQ(e.target.value); setPage(1); setActiveSavedFilterId(null); }} placeholder="Пошук за назвою, артикулом, штрихкодом..." className="pl-9" />
        </div>
        <XlsxImportButton
          templateType="goods"
          importUrl="/xlsx/import/goods"
          onImportComplete={load}
        />
        <div className="flex items-center gap-2 ml-auto">
          <ColumnsDropdown
            columns={goodsOrderedColumns}
            visibleKeys={goodsColVisible}
            onToggle={toggleGoodsCol}
            onReorder={reorderGoods}
            onRename={renameGoodsCol}
            onReset={resetGoodsConfig}
            hasCustomization={JSON.stringify(goodsOrder) !== JSON.stringify(GOODS_COLUMNS.map(c=>c.key)) || Object.keys(goodsCustomLabels).length > 0}
          />
          <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
        </div>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => { goodsFormDirty.resetDirty(); setError(''); setModal(true); }}>
          Товар
        </Button>
      </div>

      {features.bulkActionsEnabled && (
        <BulkActionsBar
          count={bulkSelect.count}
          selectedIds={[...bulkSelect.selected]}
          actions={goodsActions}
          onClear={bulkSelect.clear}
          className="mb-3"
        />
      )}

      <div className="flex gap-0">
        <div className="flex-1 min-w-0 overflow-auto border border-border rounded-xl bg-surface">
          <DataTable
            columns={[
              ...goodsVisibleColumns.map(col => ({ key: col.key, label: col.label }) satisfies DataTableColumn),
              { key: 'goodType', label: 'Тип' },
              { key: 'actions', label: '' },
            ]}
            rows={loading ? [] : (goods?.items ?? []).map(g => ({
              id: g.id as string,
              name: (
                <>
                  <p className="font-medium">{g.name}</p>
                  {g.sku && <p className="text-muted-foreground text-[12px]">{g.sku}</p>}
                </>
              ),
              category: <span className="text-[13px] text-muted-foreground">{g.category ?? '—'}</span>,
              unit: <span className="text-[13px] text-muted-foreground">{g.unit}</span>,
              purchase: <span className="text-[13px]">{g.purchasePrice != null ? `${g.purchasePrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴` : '—'}</span>,
              sale: <span className="font-medium text-[13px]">{g.salePrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</span>,
              goodType: g.goodType
                ? <Badge variant={GOOD_TYPE_BADGE[g.goodType] ?? 'secondary'}>{GOOD_TYPE_LABELS[g.goodType] ?? g.goodType}</Badge>
                : <span className="text-muted-foreground">—</span>,
              actions: (
                <div className="flex items-center justify-end gap-1">
                  <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); openEditGood(g); }}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={e => { e.stopPropagation(); setConfirmDeleteId(g.id); }}
                    className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                    title="Помітити на видалення"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ),
            }))}
            onRowClick={row => { if (detailPanel.enabled) selectGood(selectedGood?.id === row.id ? null : (goods?.items.find(g => g.id === row.id) ?? null)); }}
            selectable={features.bulkActionsEnabled}
            selectedIds={bulkSelect.selected}
            onSelectRow={id => bulkSelect.toggle(id)}
            onSelectAll={bulkSelect.toggleAll}
            emptyText="Нічого не знайдено"
          />
          {loading && <div className="flex justify-center py-10"><Spinner size="md" /></div>}
        </div>

        <DetailPanel
          open={!!selectedGood && detailPanel.enabled}
          onClose={() => selectGood(null)}
          title={selectedGood?.name ?? ''}
        >
          {selectedGood && (
            <div className="space-y-3 text-sm">
              {/* Detail tabs */}
              <div className="flex gap-1 bg-secondary rounded-lg p-0.5 mb-3">
                {([
                  { key: 'info' as const, label: 'Інформація', icon: Package },
                  { key: 'barcodes' as const, label: 'Штрихкоди', icon: Barcode },
                  { key: 'batches' as const, label: 'Партії', icon: Layers },
                ] as const).map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    onClick={() => { setGoodDetailTab(key); if (key === 'barcodes') loadBarcodes(selectedGood.id); }}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[12px] font-medium transition-colors ${goodDetailTab === key ? 'bg-surface text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    <Icon className="h-3 w-3" />
                    {label}
                  </button>
                ))}
              </div>

              {/* Info tab */}
              {goodDetailTab === 'info' && (
                <div className="space-y-3">
                  {selectedGood.sku && (
                    <div>
                      <span className="text-muted-foreground">Артикул:</span>{' '}
                      <span className="text-foreground font-mono">{selectedGood.sku}</span>
                    </div>
                  )}
                  {selectedGood.goodType && (
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Тип:</span>
                      <Badge variant={GOOD_TYPE_BADGE[selectedGood.goodType] ?? 'secondary'}>
                        {GOOD_TYPE_LABELS[selectedGood.goodType] ?? selectedGood.goodType}
                      </Badge>
                    </div>
                  )}
                  <div>
                    <span className="text-muted-foreground">Одиниця:</span>{' '}
                    <span className="text-foreground">{selectedGood.unit}</span>
                  </div>
                  {selectedGood.purchasePrice != null && (
                    <div>
                      <span className="text-muted-foreground">Ціна закупки:</span>{' '}
                      <span className="text-foreground">
                        {selectedGood.purchasePrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
                      </span>
                    </div>
                  )}
                  <div>
                    <span className="text-muted-foreground">Ціна продажу:</span>{' '}
                    <span className="text-foreground font-semibold">
                      {selectedGood.salePrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
                    </span>
                  </div>
                  {selectedGood.category && (
                    <div>
                      <span className="text-muted-foreground">Категорія:</span>{' '}
                      <span className="text-foreground">{selectedGood.category}</span>
                    </div>
                  )}
                  {selectedGood.barcode && (
                    <div>
                      <span className="text-muted-foreground">Штрихкод:</span>{' '}
                      <span className="text-foreground font-mono">{selectedGood.barcode}</span>
                    </div>
                  )}
                  {selectedGood.preferredSupplierName && (
                    <div>
                      <span className="text-muted-foreground">Постачальник:</span>{' '}
                      <span className="text-foreground">{selectedGood.preferredSupplierName}</span>
                    </div>
                  )}
                  {selectedGood.notes && (
                    <div>
                      <p className="text-muted-foreground mb-1">Нотатки:</p>
                      <p className="text-foreground italic">{selectedGood.notes}</p>
                    </div>
                  )}
                </div>
              )}

              {/* Batches tab */}
              {goodDetailTab === 'batches' && (
                <div className="space-y-3">
                  <p className="text-[12px] text-muted-foreground">
                    Партії надходження та цінова історія товару.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    leftIcon={<Layers className="h-3.5 w-3.5" />}
                    onClick={() => setBatchViewerGoodId(selectedGood.id)}
                  >
                    Відкрити Batch Viewer
                  </Button>
                </div>
              )}

              {/* Barcodes tab */}
              {goodDetailTab === 'barcodes' && (
                <div className="space-y-3">
                  {barcodesLoading ? (
                    <div className="flex justify-center py-4"><Spinner size="sm" /></div>
                  ) : (
                    <>
                      {barcodes.length === 0 && (
                        <p className="text-[12px] text-muted-foreground text-center py-3">Штрихкоди відсутні</p>
                      )}
                      {barcodes.map(bc => (
                        <div key={bc.id} className="flex items-center justify-between gap-2 bg-secondary rounded-lg px-3 py-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-[12px] font-mono text-foreground truncate">{bc.barcode}</p>
                            <p className="text-[11px] text-muted-foreground">{bc.type}</p>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {bc.isPrimary && (
                              <span title="Основний">
                                <Star className="h-3.5 w-3.5 text-amber-400 fill-current" />
                              </span>
                            )}
                            <button
                              onClick={() => deleteBarcode(selectedGood.id, bc.id)}
                              className="h-5 w-5 flex items-center justify-center rounded text-destructive/70 hover:text-destructive hover:bg-destructive/10 transition-colors"
                              title="Видалити"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </>
                  )}

                  {/* Add barcode form */}
                  <div className="border-t border-border pt-3 space-y-2">
                    <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Додати штрихкод</p>
                    <Input
                      placeholder="Штрихкод"
                      value={newBarcode}
                      onChange={e => setNewBarcode(e.target.value)}
                    />
                    <Select value={newBarcodeType} onChange={e => setNewBarcodeType(e.target.value)}>
                      {['EAN13', 'UPC', 'QR', 'CODE128'].map(t => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </Select>
                    <Button
                      size="sm"
                      className="w-full"
                      disabled={!newBarcode.trim() || addingBarcode}
                      loading={addingBarcode}
                      onClick={() => addBarcode(selectedGood.id)}
                    >
                      Додати
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </DetailPanel>
      </div>

      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      {/* Batch Viewer Modal */}
      {batchViewerGoodId && (
        <BatchViewerModal
          goodId={batchViewerGoodId}
          open={!!batchViewerGoodId}
          onClose={() => setBatchViewerGoodId(null)}
        />
      )}

      {/* Confirm mark-for-deletion dialog */}
      <Modal
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        title="Помітити товар на видалення"
        footer={
          <div className="flex gap-2 w-full">
            <Button
              variant="outline"
              onClick={() => setConfirmDeleteId(null)}
              className="flex-1"
            >
              Скасувати
            </Button>
            <Button
              variant="destructive"
              loading={saving}
              onClick={() => confirmDeleteId && markForDeletion(confirmDeleteId)}
              className="flex-1"
              leftIcon={<Trash2 className="h-4 w-4" />}
            >
              Помітити на видалення
            </Button>
          </div>
        }
      >
        <p className="text-sm text-muted-foreground">
          Товар буде позначено як видалений (soft delete). Він зникне зі списків, але залишиться в базі даних для архіву.
        </p>
      </Modal>

      <Modal open={!!editGood} onClose={async () => { if (!(await editGoodDirty.confirmClose())) return; setEditGood(null); }} title="Редагування товару"
        footer={
          <>
            <Button onClick={saveEditGood} loading={editGoodSaving} disabled={!editGoodForm.name || !editGoodForm.salePrice}>
              Зберегти
            </Button>
            <Button variant="outline" onClick={async () => { if (!(await editGoodDirty.confirmClose())) return; setEditGood(null); }}>Скасувати</Button>
          </>
        }
      >
        {editGoodError && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">{editGoodError}</div>
        )}
        <div className="space-y-4">
          <Input label="Назва" required value={editGoodForm.name} onChange={e => { setEditGoodForm(f => ({ ...f, name: e.target.value })); editGoodDirty.markDirty(); }} placeholder="Масло моторне 5W-40" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Артикул (SKU)" value={editGoodForm.sku} onChange={e => { setEditGoodForm(f => ({ ...f, sku: e.target.value })); editGoodDirty.markDirty(); }} placeholder="OIL-5W40" />
            {units.length > 0 ? (
              <Select label="Одиниця виміру" value={editGoodForm.unitId} onChange={e => {
                const unit = units.find(u => u.id === e.target.value);
                setEditGoodForm(f => ({ ...f, unitId: e.target.value, unit: unit?.shortName ?? f.unit }));
                editGoodDirty.markDirty();
              }}>
                <option value="">— вписати вручну</option>
                {units.map(u => <option key={u.id} value={u.id}>{u.shortName} ({u.name})</option>)}
              </Select>
            ) : (
              <Input label="Одиниця" value={editGoodForm.unit} onChange={e => { setEditGoodForm(f => ({ ...f, unit: e.target.value })); editGoodDirty.markDirty(); }} placeholder="шт" />
            )}
          </div>
          {units.length > 0 && !editGoodForm.unitId && (
            <Input label="Одиниця (вручну)" value={editGoodForm.unit} onChange={e => setEditGoodForm(f => ({ ...f, unit: e.target.value }))} placeholder="шт" />
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input label="Ціна закупки, ₴" type="number" value={editGoodForm.purchasePrice} onChange={e => { setEditGoodForm(f => ({ ...f, purchasePrice: e.target.value })); editGoodDirty.markDirty(); }} placeholder="350" />
            <Input label="Ціна продажу, ₴" required type="number" value={editGoodForm.salePrice} onChange={e => { setEditGoodForm(f => ({ ...f, salePrice: e.target.value })); editGoodDirty.markDirty(); }} placeholder="500" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Бренд" value={editGoodForm.brandId} onChange={e => { setEditGoodForm(f => ({ ...f, brandId: e.target.value })); editGoodDirty.markDirty(); }}>
              <option value="">—</option>
              {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
            <Input label="Категорія" value={editGoodForm.category} onChange={e => { setEditGoodForm(f => ({ ...f, category: e.target.value })); editGoodDirty.markDirty(); }} placeholder="Мастила" />
          </div>
          <Select label="Тип товару" value={editGoodForm.goodType} onChange={e => { setEditGoodForm(f => ({ ...f, goodType: e.target.value })); editGoodDirty.markDirty(); }}>
            <option value="">Не вказано</option>
            <option value="SPARE_PART">Запчастина</option>
            <option value="CONSUMABLE">Витратний матеріал</option>
            <option value="MATERIAL">Матеріал</option>
            <option value="TOOL">Інструмент</option>
          </Select>
          <Select label="Основний постачальник" value={editGoodForm.preferredSupplierId} onChange={e => { setEditGoodForm(f => ({ ...f, preferredSupplierId: e.target.value })); editGoodDirty.markDirty(); }}>
            <option value="">— Не вказано —</option>
            {suppliers.map(s => (
              <option key={s.id} value={s.id}>
                {s.companyName ?? [s.lastName, s.firstName].filter(Boolean).join(' ')}
              </option>
            ))}
          </Select>
          <Input label="Нотатки" value={editGoodForm.notes} onChange={e => { setEditGoodForm(f => ({ ...f, notes: e.target.value })); editGoodDirty.markDirty(); }} />
        </div>

        {/* ModalTabs — штрихкоди та партії */}
        <ModalTabs
          tabs={[
            {
              key: 'barcodes',
              label: 'Штрихкоди',
              icon: <Barcode className="h-3.5 w-3.5" />,
              count: modalBarcodes.length,
              content: (
                <div className="space-y-3">
                  {modalBarcodesLoading && (
                    <div className="py-6 text-center text-sm text-muted-foreground">Завантаження...</div>
                  )}
                  {!modalBarcodesLoading && barcodeError && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
                      {barcodeError}
                    </div>
                  )}
                  {!modalBarcodesLoading && !barcodeError && (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] text-muted-foreground">{modalBarcodes.length} штрихкодів</span>
                        {!showAddBarcode && (
                          <Button size="sm" variant="outline" leftIcon={<Plus className="h-3.5 w-3.5" />}
                            onClick={() => setShowAddBarcode(true)}>
                            Додати
                          </Button>
                        )}
                      </div>
                      {showAddBarcode && (
                        <AnimatedBody className="rounded-lg border border-border bg-secondary/40 p-3 space-y-3">
                          <div className="grid grid-cols-2 gap-2">
                            <Input label="Штрихкод" required value={addBarcodeForm.barcode}
                              onChange={e => setAddBarcodeForm(f => ({ ...f, barcode: e.target.value }))}
                              placeholder="4820123456789" />
                            <Select label="Тип" value={addBarcodeForm.type}
                              onChange={e => setAddBarcodeForm(f => ({ ...f, type: e.target.value }))}>
                              <option value="EAN13">EAN-13</option>
                              <option value="EAN8">EAN-8</option>
                              <option value="CODE128">Code 128</option>
                              <option value="CODE39">Code 39</option>
                              <option value="QR">QR</option>
                            </Select>
                          </div>
                          <div className="flex gap-2 justify-end">
                            <Button size="sm" variant="outline"
                              onClick={() => { setShowAddBarcode(false); setAddBarcodeForm({ barcode: '', type: 'EAN13' }); }}>
                              Скасувати
                            </Button>
                            <Button size="sm" loading={addingBarcode2}
                              disabled={!addBarcodeForm.barcode}
                              onClick={async () => {
                                if (!editGood) return;
                                setAddingBarcode2(true);
                                try {
                                  const created = await apiFetch<GoodBarcode>(`/goods/${editGood.id}/barcodes`, {
                                    method: 'POST',
                                    body: JSON.stringify({ barcode: addBarcodeForm.barcode, type: addBarcodeForm.type }),
                                  });
                                  setModalBarcodes(prev => [...prev, created]);
                                  setAddBarcodeForm({ barcode: '', type: 'EAN13' });
                                  setShowAddBarcode(false);
                                  toast.success('Штрихкод додано');
                                } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Помилка'); }
                                finally { setAddingBarcode2(false); }
                              }}>
                              Зберегти
                            </Button>
                          </div>
                        </AnimatedBody>
                      )}
                      {modalBarcodes.length > 0 && (
                        <div className="rounded-xl border border-border overflow-hidden">
                          <table className="w-full text-[13px]">
                            <thead className="bg-secondary border-b border-border">
                              <tr>
                                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Штрихкод</th>
                                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Тип</th>
                                <th className="w-10 px-3 py-2 text-muted-foreground" title="Основний">
                                  <Star className="h-3.5 w-3.5" />
                                </th>
                                <th className="w-12" />
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                              {modalBarcodes.map(bc => (
                                <tr key={bc.id} className="bg-surface hover:bg-secondary/50 transition-colors">
                                  <td className="px-3 py-2 font-mono text-foreground">{bc.barcode}</td>
                                  <td className="px-3 py-2 text-muted-foreground">{bc.type}</td>
                                  <td className="px-3 py-2 text-center">
                                    {bc.isPrimary && <Star className="h-3.5 w-3.5 text-warning-text fill-warning-text" />}
                                  </td>
                                  <td className="px-3 py-2 text-center">
                                    <button type="button"
                                      disabled={deletingBarcodeId2 === bc.id}
                                      onClick={async () => {
                                        if (!editGood) return;
                                        setDeletingBarcodeId2(bc.id);
                                        try {
                                          await apiFetch(`/goods/${editGood.id}/barcodes/${bc.id}`, { method: 'DELETE' });
                                          setModalBarcodes(prev => prev.filter(b => b.id !== bc.id));
                                          toast.success('Штрихкод видалено');
                                        } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Помилка'); }
                                        finally { setDeletingBarcodeId2(null); }
                                      }}
                                      className="text-destructive/70 hover:text-destructive hover:bg-destructive/10 p-1 rounded transition-colors"
                                      title="Видалити">
                                      <X className="h-3.5 w-3.5" />
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {modalBarcodes.length === 0 && !showAddBarcode && (
                        <p className="text-[13px] text-muted-foreground text-center py-4">Штрихкодів немає</p>
                      )}
                    </>
                  )}
                </div>
              ),
            },
            {
              key: 'batches',
              label: 'Партії',
              icon: <Package className="h-3.5 w-3.5" />,
              count: modalBatches.filter(b => b.remainingQty > 0).length,
              content: (
                <div className="space-y-3">
                  {modalBatchesLoading && (
                    <div className="py-6 text-center text-sm text-muted-foreground">Завантаження...</div>
                  )}
                  {!modalBatchesLoading && batchError && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
                      {batchError}
                    </div>
                  )}
                  {!modalBatchesLoading && !batchError && modalBatches.length === 0 && (
                    <p className="text-[13px] text-muted-foreground text-center py-4">Партій немає</p>
                  )}
                  {!modalBatchesLoading && !batchError && modalBatches.length > 0 && (
                    <div className="rounded-xl border border-border overflow-hidden">
                      <table className="w-full text-[13px]">
                        <thead className="bg-secondary border-b border-border">
                          <tr>
                            <th className="text-left px-3 py-2 text-muted-foreground font-medium">Партія / Накладна</th>
                            <th className="text-right px-3 py-2 text-muted-foreground font-medium">Отримано</th>
                            <th className="text-right px-3 py-2 text-muted-foreground font-medium">Залишок</th>
                            <th className="text-right px-3 py-2 text-muted-foreground font-medium">Собів., ₴</th>
                            <th className="text-right px-3 py-2 text-muted-foreground font-medium">Продаж, ₴</th>
                            <th className="text-left px-3 py-2 text-muted-foreground font-medium">Дата</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {modalBatches.map(b => (
                            <tr key={b.id} className="bg-surface hover:bg-secondary/50 transition-colors">
                              <td className="px-3 py-2 text-foreground">
                                {b.batchNumber ?? b.purchaseOrderNumber ?? '—'}
                              </td>
                              <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{b.receivedQty}</td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {b.remainingQty > 0
                                  ? <span className="text-foreground">{b.remainingQty}</span>
                                  : <span className="text-muted-foreground line-through">{b.remainingQty}</span>
                                }
                              </td>
                              <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                                {b.costPrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}
                              </td>
                              <td className="px-3 py-2 text-right text-foreground tabular-nums">
                                {b.salePrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}
                              </td>
                              <td className="px-3 py-2 text-muted-foreground">
                                {new Date(b.createdAt).toLocaleDateString('uk-UA')}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Modal>

      <Modal open={modal} onClose={async () => { if (!(await goodsFormDirty.confirmClose())) return; setModal(false); }} title="Новий товар / запчастина"
        footer={
          <Button onClick={create} loading={saving} disabled={!form.name || !form.salePrice} className="w-full">
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">{error}</div>
        )}
        <div className="space-y-4">
          <Input
            label="Назва"
            required
            value={form.name}
            onChange={e => { setForm(f => ({ ...f, name: e.target.value })); goodsFormDirty.markDirty(); }}
            placeholder="Масло моторне 5W-40"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Артикул (SKU)"
              value={form.sku}
              onChange={e => { setForm(f => ({ ...f, sku: e.target.value })); goodsFormDirty.markDirty(); }}
              placeholder="OIL-5W40"
            />
            {units.length > 0 ? (
              <Select
                label="Одиниця виміру"
                value={form.unitId}
                onChange={e => {
                  const unit = units.find(u => u.id === e.target.value);
                  setForm(f => ({ ...f, unitId: e.target.value, unit: unit?.shortName ?? f.unit }));
                  goodsFormDirty.markDirty();
                }}
              >
                <option value="">— вписати вручну</option>
                {units.map(u => <option key={u.id} value={u.id}>{u.shortName} ({u.name})</option>)}
              </Select>
            ) : (
              <Input
                label="Одиниця"
                value={form.unit}
                onChange={e => { setForm(f => ({ ...f, unit: e.target.value })); goodsFormDirty.markDirty(); }}
                placeholder="шт"
              />
            )}
          </div>
          {units.length > 0 && !form.unitId && (
            <Input
              label="Одиниця (вручну)"
              value={form.unit}
              onChange={e => { setForm(f => ({ ...f, unit: e.target.value })); goodsFormDirty.markDirty(); }}
              placeholder="шт"
            />
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Ціна закупки, ₴"
              type="number"
              value={form.purchasePrice}
              onChange={e => { setForm(f => ({ ...f, purchasePrice: e.target.value })); goodsFormDirty.markDirty(); }}
              placeholder="350"
            />
            <Input
              label="Ціна продажу, ₴"
              required
              type="number"
              value={form.salePrice}
              onChange={e => { setForm(f => ({ ...f, salePrice: e.target.value })); goodsFormDirty.markDirty(); }}
              placeholder="500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Бренд"
              value={form.brandId}
              onChange={e => { setForm(f => ({ ...f, brandId: e.target.value })); goodsFormDirty.markDirty(); }}
            >
              <option value="">—</option>
              {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
            <Input
              label="Категорія"
              value={form.category}
              onChange={e => { setForm(f => ({ ...f, category: e.target.value })); goodsFormDirty.markDirty(); }}
              placeholder="Мастила"
            />
          </div>
          <Select
            label="Тип товару"
            value={form.goodType}
            onChange={e => { setForm(f => ({ ...f, goodType: e.target.value })); goodsFormDirty.markDirty(); }}
          >
            <option value="">Не вказано</option>
            <option value="SPARE_PART">Запчастина</option>
            <option value="CONSUMABLE">Витратний матеріал</option>
            <option value="MATERIAL">Матеріал</option>
            <option value="TOOL">Інструмент</option>
          </Select>
          <Select
            label="Основний постачальник"
            value={form.preferredSupplierId}
            onChange={e => { setForm(f => ({ ...f, preferredSupplierId: e.target.value })); goodsFormDirty.markDirty(); }}
          >
            <option value="">— Не вказано —</option>
            {suppliers.map(s => (
              <option key={s.id} value={s.id}>
                {s.companyName ?? [s.lastName, s.firstName].filter(Boolean).join(' ')}
              </option>
            ))}
          </Select>
          <Input
            label="Штрихкод"
            value={form.barcode}
            onChange={e => { setForm(f => ({ ...f, barcode: e.target.value })); goodsFormDirty.markDirty(); }}
            placeholder="4820000000000"
          />
          <Input
            label="Нотатки"
            value={form.notes}
            onChange={e => { setForm(f => ({ ...f, notes: e.target.value })); goodsFormDirty.markDirty(); }}
          />
        </div>
      </Modal>
      <DirtyConfirmDialog {...goodsFormDirty.dialogProps} />
      <DirtyConfirmDialog {...editGoodDirty.dialogProps} />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

// ─── Services Tab ─────────────────────────────────────────────────────────────

function ServicesTab() {
  const { confirm, dialogProps } = useConfirm();
  const features = useUiFeatures();
  const detailPanel = useDetailPanel('catalog-services');
  const [services, setServices] = useState<PaginatedServices | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q);
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(false);
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [form, setForm] = useState({ name: '', description: '', price: '' });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [selectedService, setSelectedService] = useState<Service | null>(null);

  const SERVICES_COLUMNS = useMemo(() => [
    { key: 'name', label: 'Назва', defaultVisible: true },
    { key: 'price', label: 'Ціна, ₴', defaultVisible: true },
  ], []);

  const { visibleKeys: servicesColVisible, visibleColumns: servicesVisibleColumns, orderedColumns: servicesOrderedColumns, order: servicesOrder, customLabels: servicesCustomLabels, toggle: toggleServicesCol, reorder: reorderServices, renameColumn: renameServicesCol, resetConfig: resetServicesConfig } = useTableColumns('catalog-services', SERVICES_COLUMNS);

  // ── Saved filters ────────────────────────────────────────────────────────────
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const { saved: savedFilters, save: saveFilter, remove: removeFilter } = useSavedFilters<ServicesFilters>('catalog-services');

  const applyFilter = useCallback((preset: { id: string; filters: ServicesFilters }) => {
    setQ(preset.filters.search ?? '');
    setPage(1);
    setActiveSavedFilterId(preset.id);
  }, []);

  const handleSaveFilter = useCallback((name: string) => {
    const preset = saveFilter(name, { search: q });
    setActiveSavedFilterId(preset.id);
    if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
  }, [saveFilter, q, features.toastEnabled]);

  // ── Bulk select ──────────────────────────────────────────────────────────────
  const bulkSelect = useBulkSelect(services?.items ?? []);

  const servicesLoadRef = useRef<(() => void) | null>(null);

  const servicesActions = useMemo<BulkAction[]>(() => [
    {
      id: 'delete', label: 'Видалити вибрані', variant: 'destructive',
      onClick: async (ids) => {
        if (!window.confirm(`Видалити ${ids.length} ${ids.length === 1 ? 'послугу' : 'послуг'}?`)) return;
        const results = await Promise.allSettled(
          ids.map(id => apiFetch(`/services/${id}`, { method: 'DELETE' })),
        );
        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.length - succeeded;
        bulkSelect.clear();
        servicesLoadRef.current?.();
        if (features.toastEnabled) {
          if (failed === 0) toast.success(`Видалено ${succeeded} ${succeeded === 1 ? 'послугу' : 'послуг'}`);
          else toast.warning(`Видалено ${succeeded} з ${results.length}. ${failed} не вдалось`);
        }
      },
    },
  ], [bulkSelect, features.toastEnabled]);

  // ── Unsaved guard ────────────────────────────────────────────────────────────
  const servicesFormDirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), limit: '30' });
    if (debouncedQ) p.set('q', debouncedQ);
    apiFetch<PaginatedServices>(`/services?${p}`).then(setServices).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження')).finally(() => setLoading(false));
  }, [page, debouncedQ]);

  // Keep ref in sync so servicesActions can call load() without depending on it
  useEffect(() => { servicesLoadRef.current = load; }, [load]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setEditingService(null);
    setForm({ name: '', description: '', price: '' });
    servicesFormDirty.resetDirty();
    setError('');
    setModal(true);
  };

  const openEdit = (s: Service) => {
    setEditingService(s);
    setForm({ name: s.name, description: s.description ?? '', price: s.price != null ? String(s.price) : '' });
    servicesFormDirty.resetDirty();
    setError('');
    setModal(true);
  };

  const save = async () => {
    setSaving(true); setError('');
    try {
      const body = {
        name: form.name,
        description: form.description || undefined,
        price: form.price ? Number(form.price) : undefined,
      };
      if (editingService) {
        await apiFetch(`/services/${editingService.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast.success('Послугу оновлено');
      } else {
        await apiFetch<Service>('/services', { method: 'POST', body: JSON.stringify(body) });
        toast.success('Послугу створено');
      }
      setModal(false);
      setForm({ name: '', description: '', price: '' });
      servicesFormDirty.resetDirty();
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!(await confirm({ title: 'Видалити послугу?', variant: 'destructive' }))) return;
    setDeletingId(id); setError('');
    try {
      await apiFetch<void>(`/services/${id}`, { method: 'DELETE' });
      if (selectedService?.id === id) setSelectedService(null);
      load();
    }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setDeletingId(null); }
  };

  const totalPages = services ? Math.ceil(services.total / services.limit) : 1;

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">{error}</div>
      )}

      {features.savedFiltersEnabled && (
        <SavedFiltersBar<ServicesFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          className="mb-3"
        />
      )}

      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input value={q} onChange={e => { setQ(e.target.value); setPage(1); setActiveSavedFilterId(null); }} placeholder="Пошук послуг..." className="pl-9" />
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <ColumnsDropdown
            columns={servicesOrderedColumns}
            visibleKeys={servicesColVisible}
            onToggle={toggleServicesCol}
            onReorder={reorderServices}
            onRename={renameServicesCol}
            onReset={resetServicesConfig}
            hasCustomization={JSON.stringify(servicesOrder) !== JSON.stringify(SERVICES_COLUMNS.map(c=>c.key)) || Object.keys(servicesCustomLabels).length > 0}
          />
          <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
        </div>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
          Послуга
        </Button>
      </div>

      {features.bulkActionsEnabled && (
        <BulkActionsBar
          count={bulkSelect.count}
          selectedIds={[...bulkSelect.selected]}
          actions={servicesActions}
          onClear={bulkSelect.clear}
          className="mb-3"
        />
      )}

      <div className="flex gap-0">
        <div className="flex-1 min-w-0 overflow-auto border border-border rounded-xl bg-surface">
          <DataTable
            columns={[
              ...servicesVisibleColumns.map(col => ({ key: col.key, label: col.label }) satisfies DataTableColumn),
              { key: 'works', label: 'Роботи' },
              { key: 'goods', label: 'Товари' },
              { key: 'actions', label: '' },
            ]}
            rows={loading ? [] : (services?.items ?? []).map(s => ({
              id: s.id as string,
              name: (
                <>
                  <p className="text-[13px] font-medium">{s.name}</p>
                  {s.description && <p className="text-[12px] text-muted-foreground">{s.description}</p>}
                </>
              ),
              price: (
                <span className="font-medium text-foreground">
                  {s.price != null ? `${s.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴` : 'авто'}
                </span>
              ),
              works: <span className="text-muted-foreground">{s.works.length > 0 ? s.works.map(w => w.workName).join(', ') : '—'}</span>,
              goods: <span className="text-muted-foreground">{s.goods.length > 0 ? s.goods.map(g => g.goodName).join(', ') : '—'}</span>,
              actions: (
                <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="Редагувати"
                    onClick={() => openEdit(s)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                    title="Видалити"
                    onClick={() => remove(s.id)}
                    disabled={deletingId === s.id}
                    loading={deletingId === s.id}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ),
            }))}
            onRowClick={row => { if (detailPanel.enabled) setSelectedService(prev => prev?.id === row.id ? null : (services?.items.find(s => s.id === row.id) ?? null)); }}
            selectable={features.bulkActionsEnabled}
            selectedIds={bulkSelect.selected}
            onSelectRow={id => bulkSelect.toggle(id)}
            onSelectAll={bulkSelect.toggleAll}
            emptyText="Нічого не знайдено"
          />
          {loading && <div className="flex justify-center py-10"><Spinner size="md" /></div>}
        </div>

        {(() => {
          const buildServiceTabs = (s: Service): DetailPanelTab[] => [
            {
              key: 'info', label: 'Основне',
              content: (
                <div className="space-y-3">
                  {s.price != null && <PanelField label="Ціна" value={`${s.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴`} />}
                  {s.description && <PanelField label="Опис" value={s.description} />}
                </div>
              ),
            },
            {
              key: 'works', label: `Роботи (${s.works.length})`,
              content: s.works.length === 0 ? <p className="text-[13px] text-muted-foreground">Немає</p> : (
                <div className="space-y-2">
                  {s.works.map((w, i) => (
                    <div key={i} className="rounded-lg border border-border px-3 py-2 text-[13px]">
                      <p className="font-medium text-foreground">{w.workName}</p>
                      <p className="text-muted-foreground text-[12px] mt-0.5">{w.quantity} × {w.normoHours} нормо-год · {w.price.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</p>
                    </div>
                  ))}
                </div>
              ),
            },
            {
              key: 'goods', label: `Товари (${s.goods.length})`,
              content: s.goods.length === 0 ? <p className="text-[13px] text-muted-foreground">Немає</p> : (
                <div className="space-y-2">
                  {s.goods.map((g, i) => (
                    <div key={i} className="rounded-lg border border-border px-3 py-2 text-[13px]">
                      <p className="font-medium text-foreground">{g.goodName}</p>
                      <p className="text-muted-foreground text-[12px] mt-0.5">{g.quantity} {g.unit} · {g.salePrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</p>
                    </div>
                  ))}
                </div>
              ),
            },
          ];
          return (
            <DetailPanel
              open={!!selectedService && detailPanel.enabled}
              onClose={() => setSelectedService(null)}
              title={selectedService?.name ?? ''}
              tabs={selectedService ? buildServiceTabs(selectedService) : undefined}
            />
          );
        })()}
      </div>

      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      <Modal open={modal} onClose={async () => { if (!(await servicesFormDirty.confirmClose())) return; setModal(false); }} title={editingService ? 'Редагування послуги' : 'Нова комплексна послуга'}
        footer={
          <Button onClick={save} loading={saving} disabled={!form.name} className="w-full">
            {editingService ? 'Оновити' : 'Зберегти'}
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">{error}</div>
        )}
        <div className="space-y-4">
          <Input
            label="Назва"
            required
            value={form.name}
            onChange={e => { setForm(f => ({ ...f, name: e.target.value })); servicesFormDirty.markDirty(); }}
            placeholder="ТО-1 (20 000 км)"
          />
          <Input
            label="Опис"
            value={form.description}
            onChange={e => { setForm(f => ({ ...f, description: e.target.value })); servicesFormDirty.markDirty(); }}
          />
          <Input
            label="Фіксована ціна, ₴ (не заповнювати = авто)"
            type="number"
            value={form.price}
            onChange={e => { setForm(f => ({ ...f, price: e.target.value })); servicesFormDirty.markDirty(); }}
            placeholder="2500"
          />
          <p className="text-[12px] text-muted-foreground">Роботи та товари можна додати після створення</p>
        </div>
      </Modal>
      <DirtyConfirmDialog {...servicesFormDirty.dialogProps} />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

// ─── Units Tab ────────────────────────────────────────────────────────────────

function UnitsTab() {
  const { confirm, dialogProps } = useConfirm();
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ name: '', shortName: '', coefficient: '1', width: '', height: '', depth: '', volume: '', weight: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    apiFetch<Unit[]>('/units')
      .then(d => { setUnits(d); setCache('cache:units', d); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.name.trim() || !form.shortName.trim()) { setError('Усі поля є обов\'язковими'); return; }
    setSaving(true); setError('');
    try {
      await apiFetch<Unit>('/units', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          shortName: form.shortName.trim(),
          coefficient: form.coefficient ? Number(form.coefficient) : undefined,
          width: form.width ? Number(form.width) : undefined,
          height: form.height ? Number(form.height) : undefined,
          depth: form.depth ? Number(form.depth) : undefined,
          volume: form.volume ? Number(form.volume) : undefined,
          weight: form.weight ? Number(form.weight) : undefined,
        }),
      });
      setModal(false);
      setForm({ name: '', shortName: '', coefficient: '1', width: '', height: '', depth: '', volume: '', weight: '' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!(await confirm({ title: 'Видалити одиницю виміру?', variant: 'destructive' }))) return;
    try {
      await apiFetch<void>(`/units/${id}`, { method: 'DELETE' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
  };

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="flex items-center justify-between gap-3 mb-4">
        <p className="text-[13px] text-muted-foreground">Одиниці виміру, що використовуються в каталозі товарів</p>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => { setError(''); setModal(true); }}>
          Одиниця
        </Button>
      </div>

      <div className="border border-border rounded-xl bg-surface overflow-auto">
        <DataTable
          columns={[
            { key: 'shortName', label: 'Скорочення' },
            { key: 'name', label: 'Назва' },
            { key: 'unitType', label: 'Тип' },
            { key: 'actions', label: '' },
          ]}
          rows={loading ? [] : units.map(u => ({
            id: u.id as string,
            shortName: <span className="font-medium text-foreground">{u.shortName}</span>,
            name: <span className="text-muted-foreground">{u.name}</span>,
            unitType: u.isSystem
              ? <span className="text-[11px] px-1.5 py-0.5 bg-info-subtle text-info rounded">системна</span>
              : <span className="text-[11px] px-1.5 py-0.5 bg-secondary text-muted-foreground rounded">власна</span>,
            actions: !u.isSystem ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove(u.id)}
                className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            ) : null,
          }))}
          emptyText="Одиниці відсутні"
        />
        {loading && <div className="flex justify-center py-10"><Spinner size="md" /></div>}
      </div>

      <Modal open={modal} onClose={() => setModal(false)} title="Нова одиниця виміру"
        footer={
          <Button onClick={create} loading={saving} disabled={!form.name || !form.shortName} className="w-full">
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">{error}</div>
        )}
        <div className="space-y-4">
          <Input
            label="Скорочення"
            required
            value={form.shortName}
            onChange={e => setForm(f => ({ ...f, shortName: e.target.value }))}
            placeholder="шт"
          />
          <Input
            label="Повна назва"
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="штука"
          />
          <Input
            label="Коефіцієнт"
            type="number"
            value={form.coefficient}
            onChange={e => setForm(f => ({ ...f, coefficient: e.target.value }))}
            placeholder="1"
            hint="Коефіцієнт перерахунку до базової одиниці"
          />
          <div className="grid grid-cols-3 gap-2">
            <Input label="Ширина, м" type="number" value={form.width} onChange={e => setForm(f => ({ ...f, width: e.target.value }))} placeholder="0.0" />
            <Input label="Висота, м" type="number" value={form.height} onChange={e => setForm(f => ({ ...f, height: e.target.value }))} placeholder="0.0" />
            <Input label="Глибина, м" type="number" value={form.depth} onChange={e => setForm(f => ({ ...f, depth: e.target.value }))} placeholder="0.0" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input label="Об'єм, м³" type="number" value={form.volume} onChange={e => setForm(f => ({ ...f, volume: e.target.value }))} placeholder="0.0" />
            <Input label="Вага, кг" type="number" value={form.weight} onChange={e => setForm(f => ({ ...f, weight: e.target.value }))} placeholder="0.0" />
          </div>
        </div>
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

// ─── Brands Tab ───────────────────────────────────────────────────────────────

function BrandsTab() {
  const { confirm, dialogProps } = useConfirm();
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [editBrand, setEditBrand] = useState<Brand | null>(null);
  const [form, setForm] = useState({ name: '' });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    apiFetch<{ items: Brand[]; total: number }>('/brands?limit=200')
      .then(r => { setBrands(r.items); setCache('cache:brands', r.items); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setEditBrand(null); setForm({ name: '' }); setError(''); setModal(true); };
  const openEdit = (b: Brand) => { setEditBrand(b); setForm({ name: b.name }); setError(''); setModal(true); };

  const save = async () => {
    if (!form.name.trim()) { setError('Назва є обов\'язковою'); return; }
    setSaving(true); setError('');
    try {
      if (editBrand) {
        await apiFetch<Brand>(`/brands/${editBrand.id}`, { method: 'PATCH', body: JSON.stringify({ name: form.name.trim() }) });
      } else {
        await apiFetch<Brand>('/brands', { method: 'POST', body: JSON.stringify({ name: form.name.trim() }) });
      }
      setModal(false);
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка збереження'); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!(await confirm({ title: 'Видалити бренд?', message: 'Товари з цим брендом не будуть видалені.', variant: 'destructive' }))) return;
    setDeletingId(id);
    try {
      await apiFetch<void>(`/brands/${id}`, { method: 'DELETE' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setDeletingId(null); }
  };

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="flex items-center justify-between gap-3 mb-4">
        <p className="text-[13px] text-muted-foreground">Бренди та виробники запчастин і товарів</p>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
          Бренд
        </Button>
      </div>

      <div className="border border-border rounded-xl bg-surface overflow-auto">
        <DataTable
          columns={[
            { key: 'name', label: 'Назва бренду' },
            { key: 'actions', label: '', align: 'right' },
          ]}
          rows={loading ? [] : brands.map(b => ({
            id: b.id as string,
            name: <span className="font-medium text-foreground">{b.name}</span>,
            actions: (
              <div className="flex items-center justify-end gap-1">
                <Button variant="ghost" size="sm" onClick={() => openEdit(b)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={deletingId === b.id}
                  onClick={() => remove(b.id)}
                  className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ),
          }))}
          emptyText="Бренди відсутні"
        />
        {loading && <div className="flex justify-center py-10"><Spinner size="md" /></div>}
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={editBrand ? 'Редагувати бренд' : 'Новий бренд'}
        footer={
          <Button onClick={save} loading={saving} disabled={!form.name.trim()} className="w-full">
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">{error}</div>
        )}
        <Input
          label="Назва бренду"
          required
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          placeholder="наприклад: Bosch, NGK, Brembo"
          autoFocus
        />
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS: { key: Tab; label: string }[] = [
  { key: 'works', label: 'Роботи' },
  { key: 'goods', label: 'Товари та запчастини' },
  { key: 'services', label: 'Комплексні послуги' },
  { key: 'units', label: 'Одиниці виміру' },
  { key: 'brands', label: 'Бренди' },
];

export default function CatalogPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER']);
  const [tab, setTab] = useState<Tab>('works');

  return (
    <div className="page-container">
      <h1 className="page-title mb-6">Каталог</h1>

      <div className="flex gap-1 bg-secondary rounded-lg p-1 mb-6 w-fit">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-md text-[13px] font-medium transition-colors ${tab === t.key ? 'bg-surface text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'works' && <WorksTab />}
      {tab === 'goods' && <GoodsTab />}
      {tab === 'services' && <ServicesTab />}
      {tab === 'units' && <UnitsTab />}
      {tab === 'brands' && <BrandsTab />}
    </div>
  );
}
