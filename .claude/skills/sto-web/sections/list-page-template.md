# sto-web — list-page-template

> Частина скіла `sto-web`; винесено дослівно, щоб кожен файл влазив в один Read.

## Список сторінки — повний шаблон

> **Еталон:** `apps/web/src/app/(app)/work-orders/page.tsx` — читай перед написанням будь-якого списку.

```typescript
'use client';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useTableColumns } from '@/hooks/useTableColumns';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { useConfirm } from '@/hooks/useConfirm';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { SavedFiltersBar } from '@/components/ui/saved-filters-bar';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────
interface Item { id: string; name: string; status: string; /* ... */ }
interface Paginated { items: Item[]; total: number; page: number; limit: number; }
interface MyFilters extends Record<string, unknown> { search: string; status: string; showDeleted: boolean; }

export default function MyListPage() {
  useRequireAuth(['OWNER', 'ADMIN']);

  // ── State ───────────────────────────────────────────────
  const [data, setData] = useState<Paginated | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [statusFilter, setStatusFilter] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [page, setPage] = useState(1);
  const [showModal, setShowModal] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', status: '' });
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // ── UI Features ─────────────────────────────────────────
  const features = useUiFeatures();
  const { confirm, dialogProps } = useConfirm();

  // ── Columns ─────────────────────────────────────────────
  const COLUMNS = useMemo(() => [
    { key: 'name',   label: 'Назва',   defaultVisible: true },
    { key: 'status', label: 'Статус',  defaultVisible: true },
    { key: 'extra',  label: 'Додатково', defaultVisible: false },  // прихована за замовч.
  ], []);
  // visibleColumns — видимі у user-defined порядку з кастомними label
  // orderedColumns — всі у user-defined порядку (для ColumnsDropdown)
  const {
    visibleKeys: colVisible, visibleColumns, orderedColumns,
    order, customLabels,
    toggle: toggleCol, reorder, renameColumn, resetConfig,
  } = useTableColumns('my-page', COLUMNS);

  // ── Saved Filters ────────────────────────────────────────
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const { saved: savedFilters, save: saveFilter, remove: removeFilter } = useSavedFilters<MyFilters>('my-page');
  const applyFilter = useCallback((preset: { id: string; filters: MyFilters }) => {
    setSearch(preset.filters.search ?? '');
    setStatusFilter(preset.filters.status ?? '');
    setShowDeleted(preset.filters.showDeleted ?? false);
    setPage(1);
    setActiveSavedFilterId(preset.id);
  }, []);
  const handleSaveFilter = useCallback((name: string) => {
    const preset = saveFilter(name, { search, status: statusFilter, showDeleted });
    setActiveSavedFilterId(preset.id);
    toast.success(`Фільтр "${name}" збережено`);
  }, [saveFilter, search, statusFilter, showDeleted]);

  // ── Bulk Select ──────────────────────────────────────────
  const bulkSelect = useBulkSelect(data?.items ?? []);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
  }, [bulkSelect.someSelected]);
  const bulkActions: BulkAction[] = [
    {
      label: 'Видалити вибрані',
      variant: 'destructive',
      onClick: async (ids) => {
        if (!(await confirm({ title: `Видалити ${ids.length} записів?`, variant: 'destructive' }))) return;
        const results = await Promise.allSettled(ids.map(id => apiFetch(`/resource/${id}`, { method: 'DELETE' })));
        const failed = results.filter(r => r.status === 'rejected').length;
        if (failed) toast.warning(`Видалено ${ids.length - failed} з ${ids.length}`);
        else toast.success(`Видалено ${ids.length}`);
        bulkSelect.clear(); load();
      },
    },
  ];

  // ── Dirty Form Guard ─────────────────────────────────────
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  // ── Load ─────────────────────────────────────────────────
  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (debouncedSearch) params.set('q', debouncedSearch);
    if (statusFilter) params.set('status', statusFilter);
    if (showDeleted) params.set('showDeleted', 'true');
    apiFetch<Paginated>(`/resource?${params}`)
      .then(d => { if (mountedRef.current) { setData(d); } })
      .catch((e: unknown) => { if (mountedRef.current) toast.error(e instanceof Error ? e.message : 'Помилка завантаження'); })
      .finally(() => { if (mountedRef.current) setLoading(false); });
  }, [page, debouncedSearch, statusFilter, showDeleted]);
  useEffect(() => { load(); }, [load]);

  // ── Modal Handlers ───────────────────────────────────────
  const openCreate = () => {
    setEditingItem(null);
    setForm({ name: '', status: '' });
    dirty.resetDirty();
    setShowModal(true);
  };
  const openEdit = (item: Item) => {
    setEditingItem(item);
    setForm({ name: item.name, status: item.status });
    dirty.resetDirty();
    setShowModal(true);
  };
  const closeModal = async () => {
    if (!(await dirty.confirmClose())) return;
    setShowModal(false);
  };

  const handleSave = async () => {
    if (!form.name) return;
    setSaving(true);
    try {
      if (editingItem) {
        await apiFetch(`/resource/${editingItem.id}`, { method: 'PATCH', body: JSON.stringify(form) });
        toast.success('Збережено');
      } else {
        await apiFetch('/resource', { method: 'POST', body: JSON.stringify(form) });
        toast.success('Створено');
      }
      dirty.resetDirty();
      setShowModal(false);
      load();
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  // ── Render ───────────────────────────────────────────────
  return (
    <div className="page-fill p-4 md:p-6">
      {/* Заголовок — тільки h1, БЕЗ кнопок */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Назва розділу</h1>
        </div>
      </div>

      {/* Saved Filters */}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<MyFilters>
          saved={savedFilters} activeId={activeSavedFilterId}
          onApply={applyFilter} onSave={handleSaveFilter} onRemove={removeFilter}
          hideSaveButton
        />
      )}

      {/* Filters row — всі кнопки тут, gap від page-fill, НЕ додавати mb-* */}
      <div className="flex gap-3 flex-wrap shrink-0">
        <Input
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); setActiveSavedFilterId(null); }}
          placeholder="Пошук..."
          leftElement={<Search />}
          className="flex-1 min-w-48"
        />
        <Select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); setActiveSavedFilterId(null); }} className="w-44">
          <option value="">Всі статуси</option>
          <option value="ACTIVE">Активні</option>
        </Select>
        {/* Права група — ml-auto */}
        <div className="flex items-center gap-2 ml-auto">
          {/* Eye: size="icon-sm", border-primary при showDeleted=true */}
          <Button
            variant="outline"
            size="icon-sm"
            title={showDeleted ? 'Сховати видалені' : 'Показати видалені'}
            onClick={() => { setShowDeleted(d => !d); setPage(1); setActiveSavedFilterId(null); }}
            className={showDeleted ? 'border-primary text-primary' : ''}
          >
            {showDeleted ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
          {features.savedFiltersEnabled && <SaveFilterButton onSave={handleSaveFilter} />}
          {/* ColumnsDropdown — якщо є useTableColumns */}
          <ColumnsDropdown
            columns={orderedColumns}
            visibleKeys={colVisible}
            onToggle={toggleCol}
            onReorder={reorder}
            onRename={renameColumn}
            onReset={resetConfig}
            hasCustomization={JSON.stringify(order) !== JSON.stringify(COLUMNS.map(c => c.key)) || Object.keys(customLabels).length > 0}
          />
          {/* СТАНДАРТ: КОЖЕН список із DetailPanel МУСИТЬ мати DetailPanelToggle поряд із
              ColumnsDropdown. enabled/toggle — з useListPage().detailPanel (або useDetailPanel(key)
              для сторінок поза useListPage, напр. inventory). Без тогла користувач не може
              сховати панель, а на deep-tab-сторінках (Купівля) панель мовчки зникає (Bug #496/#505). */}
          <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
          {/* Кнопка створення — без size=, конкретна назва (не "Додати") */}
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
            Назва об'єкта
          </Button>
        </div>
      </div>

      {/* Bulk Actions Bar */}
      {features.bulkActionsEnabled && bulkSelect.count > 0 && (
        <BulkActionsBar count={bulkSelect.count} selectedIds={Array.from(bulkSelect.selected)}
          actions={bulkActions} onClear={bulkSelect.clear} className="mb-3" />
      )}

      {/* Table */}
      <Table>
        <TableHeader>
          <TableRow>
            {features.bulkActionsEnabled && (
              <TableHead className="w-9 pr-0">
                <input type="checkbox" checked={bulkSelect.allSelected} ref={selectAllRef}
                  onChange={bulkSelect.toggleAll} className="h-3.5 w-3.5 rounded border-border" />
              </TableHead>
            )}
            {/* ✅ map по visibleColumns — порядок і назви з user config */}
            {visibleColumns.map(col => <TableHead key={col.key}>{col.label}</TableHead>)}
            <TableHead /> {/* actions */}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow><TableCell colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)} className="py-12 text-center"><Spinner /></TableCell></TableRow>
          ) : !data?.items.length ? (
            <TableRow><TableCell colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)} className="p-0"><EmptyState title="Нічого не знайдено" /></TableCell></TableRow>
          ) : data.items.map(item => (
            <TableRow key={item.id} className={cn(item.status === 'DELETED' && 'opacity-50')}>
              {features.bulkActionsEnabled && (
                <TableCell className="w-9 pr-0">
                  <input type="checkbox" checked={bulkSelect.isSelected(item.id)}
                    onChange={() => bulkSelect.toggle(item.id)} className="h-3.5 w-3.5 rounded border-border" />
                </TableCell>
              )}
              {/* ✅ map по visibleColumns — кожна комірка через if/key */}
              {visibleColumns.map(col => {
                if (col.key === 'name')   return <TableCell key="name" className="font-medium">{item.name}</TableCell>;
                if (col.key === 'status') return <TableCell key="status">{item.status}</TableCell>;
                if (col.key === 'extra')  return <TableCell key="extra">—</TableCell>;
                return null;
              })}
              <TableCell className="text-right">
                <Button variant="ghost" size="sm" onClick={() => openEdit(item)}>Редагувати</Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Modal */}
      <Modal open={showModal} onClose={closeModal} title={editingItem ? 'Редагувати' : 'Додати'}>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Назва <span className="text-destructive-text">*</span></label>
            <Input value={form.name} onChange={e => { setForm(f => ({ ...f, name: e.target.value })); dirty.markDirty(); }} />
          </div>
        </div>
        <div className="flex gap-2 mt-6">
          <Button onClick={handleSave} loading={saving}>Зберегти</Button>
          <Button variant="outline" onClick={closeModal}>Скасувати</Button>
        </div>
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
```

---
