'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { Plus, Pencil, Search, Trash2, BookOpen } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
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
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useTableColumns } from '@/hooks/useTableColumns';
import { useColumnDrag } from '@/hooks/useColumnDrag';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { toast } from '@/lib/toast';
import { fmtMoney } from '@/lib/format';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Category {
  id: string;
  name: string;
  children: Category[];
}
interface Work {
  id: string;
  categoryId: string;
  categoryName: string;
  name: string;
  normoHours: number;
  price: number;
  description: string | null;
  isWarranty: boolean;
}
interface PaginatedWorks {
  items: Work[];
  total: number;
  page: number;
  limit: number;
}

interface WorksFilters extends Record<string, unknown> {
  search: string;
  categoryId: string;
}

function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex justify-center gap-1.5 mt-4">
      {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`h-8 w-8 rounded-lg text-[13px] font-medium border transition-colors ${
            p === page
              ? 'bg-primary text-primary-foreground border-primary'
              : 'border-border text-muted-foreground bg-surface hover:bg-secondary'
          }`}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

// ─── Works Tab ────────────────────────────────────────────────────────────────

export default function WorksTab() {
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
  const [form, setForm] = useState({
    categoryId: '',
    name: '',
    normoHours: '',
    price: '',
    description: '',
    isWarranty: false,
  });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [selectedWork, setSelectedWork] = useState<Work | null>(null);
  const [editWork, setEditWork] = useState<Work | null>(null);
  const [editForm, setEditForm] = useState({
    categoryId: '',
    name: '',
    normoHours: '',
    price: '',
    description: '',
    isWarranty: false,
  });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const WORKS_COLUMNS = useMemo(
    () => [
      { key: 'name', label: 'Назва', defaultVisible: true },
      { key: 'category', label: 'Категорія', defaultVisible: true },
      { key: 'normo', label: 'Нормо-год', defaultVisible: true },
      { key: 'price', label: 'Ціна, ₴', defaultVisible: true },
    ],
    [],
  );

  const {
    visibleKeys: worksColVisible,
    visibleColumns: worksVisibleColumns,
    orderedColumns: worksOrderedColumns,
    order: worksOrder,
    customLabels: worksCustomLabels,
    toggle: toggleWorksCol,
    reorder: reorderWorks,
    renameColumn: renameWorksCol,
    resetConfig: resetWorksConfig,
  } = useTableColumns('catalog-works', WORKS_COLUMNS);
  const { dragProps: worksDragProps } = useColumnDrag(
    worksVisibleColumns,
    reorderWorks,
    worksOrderedColumns,
  );

  // ── Saved filters ────────────────────────────────────────────────────────────
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const {
    saved: savedFilters,
    save: saveFilter,
    remove: removeFilter,
  } = useSavedFilters<WorksFilters>('catalog-works');

  const applyFilter = useCallback((preset: { id: string; filters: WorksFilters }) => {
    setQ(preset.filters.search ?? '');
    setSelectedCat(preset.filters.categoryId ?? '');
    setPage(1);
    setActiveSavedFilterId(preset.id);
  }, []);

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = saveFilter(name, { search: q, categoryId: selectedCat });
      setActiveSavedFilterId(preset.id);
      if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
    },
    [saveFilter, q, selectedCat, features.toastEnabled],
  );

  // ── Bulk select ──────────────────────────────────────────────────────────────
  const bulkSelect = useBulkSelect(works?.items ?? []);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
  }, [bulkSelect.someSelected]);

  // loadRef allows bulkDelete (defined before load) to call the latest load()
  const worksLoadRef = useRef<(() => void) | null>(null);

  const worksActions = useMemo<BulkAction[]>(
    () => [
      {
        id: 'delete',
        label: 'Видалити вибрані',
        variant: 'destructive',
        onClick: async ids => {
          if (!window.confirm(`Видалити ${ids.length} ${ids.length === 1 ? 'роботу' : 'робіт'}?`))
            return;
          const results = await Promise.allSettled(
            ids.map(id => apiFetch(`/works/${id}`, { method: 'DELETE' })),
          );
          const succeeded = results.filter(r => r.status === 'fulfilled').length;
          const failed = results.length - succeeded;
          bulkSelect.clear();
          worksLoadRef.current?.();
          if (features.toastEnabled) {
            if (failed === 0)
              toast.success(`Видалено ${succeeded} ${succeeded === 1 ? 'роботу' : 'робіт'}`);
            else toast.warning(`Видалено ${succeeded} з ${results.length}. ${failed} не вдалось`);
          }
        },
      },
    ],
    [bulkSelect, features.toastEnabled],
  );

  // ── Unsaved guard ────────────────────────────────────────────────────────────
  const worksFormDirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
  const editWorkDirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  useEffect(() => {
    // Reference data — paint instantly from sessionStorage, refresh in background.
    const cached = getCached<Category[]>('cache:work-categories');
    if (cached) setCategories(cached);
    apiFetch<Category[]>('/work-categories')
      .then(d => {
        setCategories(d);
        setCache('cache:work-categories', d);
      })
      .catch((e: unknown) => {
        if (!cached) setError(e instanceof Error ? e.message : 'Помилка завантаження категорій');
      });
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
    apiFetch<PaginatedWorks>(`/works?${p}`)
      .then(setWorks)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження'))
      .finally(() => setLoading(false));
  }, [page, selectedCat, debouncedQ]);

  // Keep ref in sync so worksActions can call load() without depending on it
  useEffect(() => {
    worksLoadRef.current = load;
  }, [load]);

  useEffect(() => {
    load();
  }, [load]);

  const flatCategories = (cats: Category[], depth = 0): Array<Category & { depth: number }> =>
    cats.flatMap(c => [{ ...c, depth }, ...flatCategories(c.children, depth + 1)]);

  const create = async () => {
    const normo = Number(form.normoHours);
    const price = Number(form.price);
    if (!Number.isFinite(normo) || normo <= 0) {
      setError('Норма-годин повинна бути більше нуля');
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setError("Ціна повинна бути невід'ємним числом");
      return;
    }
    setSaving(true);
    setError('');
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
      setForm({
        categoryId: '',
        name: '',
        normoHours: '',
        price: '',
        description: '',
        isWarranty: false,
      });
      worksFormDirty.resetDirty();
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!(await confirm({ title: 'Видалити роботу?', variant: 'destructive' }))) return;
    setDeletingId(id);
    setError('');
    try {
      await apiFetch<void>(`/works/${id}`, { method: 'DELETE' });
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка видалення');
    } finally {
      setDeletingId(null);
    }
  };

  const openEditWork = (w: Work) => {
    setEditWork(w);
    setEditForm({
      categoryId: w.categoryId,
      name: w.name,
      normoHours: String(w.normoHours),
      price: String(w.price),
      description: w.description ?? '',
      isWarranty: w.isWarranty,
    });
    setEditError('');
    editWorkDirty.resetDirty();
  };

  const saveEditWork = async () => {
    if (!editWork) return;
    const normo = Number(editForm.normoHours);
    const price = Number(editForm.price);
    if (!Number.isFinite(normo) || normo <= 0) {
      setEditError('Норма-годин повинна бути більше нуля');
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setEditError("Ціна повинна бути невід'ємним числом");
      return;
    }
    setEditSaving(true);
    setEditError('');
    try {
      await apiFetch<Work>(`/works/${editWork.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          categoryId: editForm.categoryId,
          name: editForm.name,
          normoHours: normo,
          price,
          description: editForm.description || undefined,
          isWarranty: editForm.isWarranty,
        }),
      });
      editWorkDirty.resetDirty();
      setEditWork(null);
      load();
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setEditSaving(false);
    }
  };

  const flat = flatCategories(categories);
  const totalPages = works ? Math.ceil(works.total / works.limit) : 1;

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<WorksFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          className="mb-3"
          hideSaveButton
        />
      )}

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={q}
            onChange={e => {
              setQ(e.target.value);
              setPage(1);
              setActiveSavedFilterId(null);
            }}
            placeholder="Пошук робіт..."
            className="pl-9"
          />
        </div>
        <Select
          value={selectedCat}
          onChange={e => {
            setSelectedCat(e.target.value);
            setPage(1);
            setActiveSavedFilterId(null);
          }}
        >
          <option value="">Всі категорії</option>
          {flat.map(c => (
            <option key={c.id} value={c.id}>
              {' '.repeat(c.depth * 4)}
              {c.name}
            </option>
          ))}
        </Select>
        <XlsxImportButton
          templateType="works"
          importUrl="/xlsx/import/works"
          onImportComplete={load}
        />
        <div className="flex items-center gap-2 ml-auto">
          {features.savedFiltersEnabled && <SaveFilterButton onSave={handleSaveFilter} />}
          <ColumnsDropdown
            columns={worksOrderedColumns}
            visibleKeys={worksColVisible}
            onToggle={toggleWorksCol}
            onReorder={reorderWorks}
            onRename={renameWorksCol}
            onReset={resetWorksConfig}
            hasCustomization={
              JSON.stringify(worksOrder) !== JSON.stringify(WORKS_COLUMNS.map(c => c.key)) ||
              Object.keys(worksCustomLabels).length > 0
            }
          />
          <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
        </div>
        <Button
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => {
            setForm({
              categoryId: flat[0]?.id ?? '',
              name: '',
              normoHours: '',
              price: '',
              description: '',
              isWarranty: false,
            });
            worksFormDirty.resetDirty();
            setError('');
            setModal(true);
          }}
        >
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
          <Table>
            <TableHeader>
              <TableRow>
                {features.bulkActionsEnabled && (
                  <TableHead className="w-10">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={bulkSelect.allSelected}
                      onChange={bulkSelect.toggleAll}
                      className="h-4 w-4 accent-primary"
                      aria-label="Обрати всі"
                    />
                  </TableHead>
                )}
                {worksVisibleColumns.map(col => (
                  <TableHead key={col.key} {...worksDragProps(col.key)}>
                    {col.label}
                  </TableHead>
                ))}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell
                    colSpan={worksVisibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)}
                    className="py-10 text-center"
                  >
                    <div className="flex justify-center">
                      <Spinner size="md" />
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!loading && works?.items.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={worksVisibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)}
                    className="p-0"
                  >
                    <EmptyState icon={BookOpen} title="Нічого не знайдено" />
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                works?.items.map(w => (
                  <TableRow
                    key={w.id}
                    className={`cursor-pointer ${selectedWork?.id === w.id ? 'bg-secondary' : ''}`}
                    onClick={() => {
                      if (detailPanel.enabled)
                        setSelectedWork(prev => (prev?.id === w.id ? null : w));
                    }}
                  >
                    {features.bulkActionsEnabled && (
                      <TableCell onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={bulkSelect.isSelected(w.id)}
                          onChange={() => bulkSelect.toggle(w.id)}
                          className="h-4 w-4 accent-primary"
                          aria-label={`Обрати ${w.name}`}
                        />
                      </TableCell>
                    )}
                    {worksVisibleColumns.map(col => {
                      if (col.key === 'name')
                        return (
                          <TableCell key="name">
                            <p className="text-[13px] font-medium text-foreground">{w.name}</p>
                            {w.isWarranty && (
                              <span className="text-[11px] text-success">Гарантійна</span>
                            )}
                            {w.description && (
                              <p className="text-[12px] text-muted-foreground mt-0.5">
                                {w.description}
                              </p>
                            )}
                          </TableCell>
                        );
                      if (col.key === 'category')
                        return (
                          <TableCell key="category" className="text-[13px] text-muted-foreground">
                            {w.categoryName}
                          </TableCell>
                        );
                      if (col.key === 'normo')
                        return (
                          <TableCell key="normo" className="text-[13px]">
                            {w.normoHours}
                          </TableCell>
                        );
                      if (col.key === 'price')
                        return (
                          <TableCell key="price" className="font-medium text-[13px]">
                            {fmtMoney(w.price)}
                          </TableCell>
                        );
                      return null;
                    })}
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={e => {
                            e.stopPropagation();
                            openEditWork(w);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={e => {
                            e.stopPropagation();
                            remove(w.id);
                          }}
                          disabled={deletingId === w.id}
                          loading={deletingId === w.id}
                          className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>

        {(() => {
          const buildWorkTabs = (w: Work): DetailPanelTab[] => [
            {
              key: 'info',
              label: 'Основне',
              content: (
                <div className="space-y-3">
                  <PanelField label="Категорія" value={w.categoryName} />
                  <PanelField label="Нормо-год" value={String(w.normoHours)} />
                  <PanelField label="Ціна" value={`${fmtMoney(w.price)} ₴`} />
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

      <Modal
        open={modal}
        onClose={async () => {
          if (!(await worksFormDirty.confirmClose())) return;
          setModal(false);
        }}
        title="Нова робота"
        size="lg"
        footer={
          <Button
            onClick={create}
            loading={saving}
            disabled={!form.name || !form.categoryId || !form.normoHours || !form.price}
            className="w-full"
          >
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <div className="space-y-4">
          <Select
            label="Категорія"
            required
            value={form.categoryId}
            onChange={e => {
              setForm(f => ({ ...f, categoryId: e.target.value }));
              worksFormDirty.markDirty();
            }}
          >
            {flat.map(c => (
              <option key={c.id} value={c.id}>
                {' '.repeat(c.depth * 4)}
                {c.name}
              </option>
            ))}
          </Select>
          <Input
            label="Назва"
            required
            value={form.name}
            onChange={e => {
              setForm(f => ({ ...f, name: e.target.value }));
              worksFormDirty.markDirty();
            }}
            placeholder="Заміна масла"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Нормо-год"
              required
              type="number"
              value={form.normoHours}
              onChange={e => {
                setForm(f => ({ ...f, normoHours: e.target.value }));
                worksFormDirty.markDirty();
              }}
              placeholder="1.5"
            />
            <Input
              label="Ціна, ₴"
              required
              type="number"
              value={form.price}
              onChange={e => {
                setForm(f => ({ ...f, price: e.target.value }));
                worksFormDirty.markDirty();
              }}
              placeholder="500"
            />
          </div>
          <Input
            label="Опис"
            value={form.description}
            onChange={e => {
              setForm(f => ({ ...f, description: e.target.value }));
              worksFormDirty.markDirty();
            }}
          />
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.isWarranty}
              onChange={e => {
                setForm(f => ({ ...f, isWarranty: e.target.checked }));
                worksFormDirty.markDirty();
              }}
              className="h-4 w-4 accent-primary"
            />
            <span className="text-sm text-foreground">
              Гарантійна робота (виконується безкоштовно)
            </span>
          </label>
        </div>
      </Modal>

      <Modal
        open={!!editWork}
        onClose={async () => {
          if (!(await editWorkDirty.confirmClose())) return;
          setEditWork(null);
        }}
        title="Редагування роботи"
        footer={
          <>
            <Button
              onClick={saveEditWork}
              loading={editSaving}
              disabled={
                !editForm.name || !editForm.categoryId || !editForm.normoHours || !editForm.price
              }
            >
              Зберегти
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                if (!(await editWorkDirty.confirmClose())) return;
                setEditWork(null);
              }}
            >
              Скасувати
            </Button>
          </>
        }
      >
        {editError && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
            {editError}
          </div>
        )}
        <div className="space-y-4">
          <Select
            label="Категорія"
            required
            value={editForm.categoryId}
            onChange={e => {
              setEditForm(f => ({ ...f, categoryId: e.target.value }));
              editWorkDirty.markDirty();
            }}
          >
            {flat.map(c => (
              <option key={c.id} value={c.id}>
                {' '.repeat(c.depth * 4)}
                {c.name}
              </option>
            ))}
          </Select>
          <Input
            label="Назва"
            required
            value={editForm.name}
            onChange={e => {
              setEditForm(f => ({ ...f, name: e.target.value }));
              editWorkDirty.markDirty();
            }}
            placeholder="Заміна масла"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Нормо-год"
              required
              type="number"
              value={editForm.normoHours}
              onChange={e => {
                setEditForm(f => ({ ...f, normoHours: e.target.value }));
                editWorkDirty.markDirty();
              }}
              placeholder="1.5"
            />
            <Input
              label="Ціна, ₴"
              required
              type="number"
              value={editForm.price}
              onChange={e => {
                setEditForm(f => ({ ...f, price: e.target.value }));
                editWorkDirty.markDirty();
              }}
              placeholder="500"
            />
          </div>
          <Input
            label="Опис"
            value={editForm.description}
            onChange={e => {
              setEditForm(f => ({ ...f, description: e.target.value }));
              editWorkDirty.markDirty();
            }}
          />
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={editForm.isWarranty}
              onChange={e => {
                setEditForm(f => ({ ...f, isWarranty: e.target.checked }));
                editWorkDirty.markDirty();
              }}
              className="h-4 w-4 accent-primary"
            />
            <span className="text-sm text-foreground">
              Гарантійна робота (виконується безкоштовно)
            </span>
          </label>
        </div>
      </Modal>
      <DirtyConfirmDialog {...worksFormDirty.dialogProps} />
      <DirtyConfirmDialog {...editWorkDirty.dialogProps} />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
