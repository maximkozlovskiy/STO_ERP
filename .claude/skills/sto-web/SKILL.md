---
name: sto-web
description: >
  Create Next.js 15 pages, components, and hooks for STO ERP web app. Use when the user says "зроби сторінку", "компонент", "веб інтерфейс", "фронтенд", "таблиця", "форма", or implementing the web UI layer. Produces production-ready Next.js code following real STO ERP conventions.
model: claude-sonnet-4-6
bypassPermissions: true
---

# sto-web — Next.js 15 Web UI Skill

## Before Starting

1. Read `MemoryManual.md` — current state, gotchas, recent changes
2. Read `sto-dev` — coding standards (patterns, anti-patterns)
3. Check existing similar page for patterns — **не вигадуй, копіюй існуючий стиль**
4. Confirm API endpoint exists (або запусти `sto-backend` спочатку)

---

## Реальна структура проєкту

```
apps/web/src/
├── app/                        ← Next.js App Router pages
│   ├── (auth)/login/           ← публічна сторінка
│   ├── work-orders/page.tsx    ← ЕТАЛОН списку (читай перед новою сторінкою)
│   ├── work-orders/[id]/       ← деталі наряду
│   ├── employees/page.tsx
│   ├── crm/page.tsx
│   ├── invoices/page.tsx
│   ├── purchase-orders/page.tsx
│   ├── stock-documents/page.tsx
│   ├── catalog/page.tsx        ← 3 вкладки: works/goods/services
│   ├── calendar/page.tsx
│   ├── inventory/page.tsx
│   ├── settlements/page.tsx
│   └── settings/page.tsx
├── components/ui/              ← готові примітиви (не переписувати!)
├── hooks/                      ← готові хуки (не переписувати!)
└── lib/
    ├── api-client.ts           ← apiFetch / apiBlobFetch / apiMultipartFetch
    ├── auth.ts                 ← useRequireAuth, getToken
    ├── toast.ts                ← toast.success/error/warning/info
    ├── ref-cache.ts            ← getCached / setCache (sessionStorage)
    └── utils.ts                ← cn, displayCounterpartyName, daysUntil
```

---

## API Client — РЕАЛЬНИЙ паттерн

```typescript
// ✅ Завжди apiFetch — НЕ axios, НЕ fetch напряму
import { apiFetch } from '@/lib/api-client';

// GET з пагінацією
const data = await apiFetch<{ items: T[]; total: number }>(`/resource?page=${page}&limit=20`);

// POST
const created = await apiFetch<T>('/resource', { method: 'POST', body: JSON.stringify(dto) });

// PATCH
await apiFetch(`/resource/${id}`, { method: 'PATCH', body: JSON.stringify(dto) });

// DELETE (soft)
await apiFetch(`/resource/${id}`, { method: 'DELETE' });

// ❌ НЕ використовувати axios, TanStack Query, React Hook Form, Zod resolver
```

---

## Список сторінки — повний шаблон

> **Еталон:** `apps/web/src/app/work-orders/page.tsx` — читай перед написанням будь-якого списку.

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
    <div className="page-container">
      <div className="page-header mb-6">
        <h1 className="page-title">Назва розділу</h1>
        <Button onClick={openCreate}><Plus className="h-4 w-4" />Додати</Button>
      </div>

      {/* Saved Filters */}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<MyFilters>
          saved={savedFilters} activeId={activeSavedFilterId}
          onApply={applyFilter} onSave={handleSaveFilter} onRemove={removeFilter}
          className="mb-3"
        />
      )}

      {/* Filters row */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input value={search} onChange={e => { setSearch(e.target.value); setPage(1); setActiveSavedFilterId(null); }}
            placeholder="Пошук..." className="pl-9" />
        </div>
        <Select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); setActiveSavedFilterId(null); }} className="w-44">
          <option value="">Всі статуси</option>
          <option value="ACTIVE">Активні</option>
        </Select>
        {/* ColumnsDropdown — завжди ml-auto, останній у рядку */}
        {/* columns={orderedColumns} — НЕ COLUMNS: відображає user-defined порядок і кастомні label */}
        <ColumnsDropdown
          columns={orderedColumns}
          visibleKeys={colVisible}
          onToggle={toggleCol}
          onReorder={reorder}
          onRename={renameColumn}
          onReset={resetConfig}
          hasCustomization={JSON.stringify(order) !== JSON.stringify(COLUMNS.map(c=>c.key)) || Object.keys(customLabels).length > 0}
          className="ml-auto"
        />
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

## Готові UI-примітиви — таблиця

| Компонент | Файл | Використовувати коли |
|---|---|---|
| `<Modal>` | `ui/modal.tsx` | Будь-яке модальне вікно |
| `<ConfirmDialog>` | `ui/confirm-dialog.tsx` | Підтвердження дії (разом з `useConfirm`) |
| `<Input>` | `ui/input.tsx` | Текстове поле |
| `<Select>` | `ui/select.tsx` | Випадаючий список |
| `<Button>` | `ui/button.tsx` | Кнопка (підтримує `loading`, `variant`) |
| `<Badge>` | `ui/badge.tsx` | Статусний тег |
| `<EmptyState>` | `ui/empty-state.tsx` | Порожній стан списку |
| `<Spinner>` | `ui/spinner.tsx` | Індикатор завантаження |
| `<DetailPanel>` | `ui/detail-panel.tsx` | Бокова панель деталей (split-view) |
| `<SearchCombobox>` | `ui/search-combobox.tsx` | Autocomplete з сервер-стороннім пошуком |
| `<SearchPickerModal>` | `ui/search-picker-modal.tsx` | Picker з пошуком і пагінацією |
| `<DatePickerInput>` | `ui/date-picker-input.tsx` | Поле вибору дати |
| `<ColumnsDropdown>` | `ui/columns-dropdown.tsx` | Управління видимістю колонок |
| `<BulkActionsBar>` | `ui/bulk-actions-bar.tsx` | Панель групових дій |
| `<SavedFiltersBar>` | `ui/saved-filters-bar.tsx` | Панель збережених фільтрів |
| `<Table>` + friends | `ui/table.tsx` | Таблиця |

---

## Хуки — таблиця

| Хук | Файл | Призначення |
|---|---|---|
| `useUiFeatures` | `hooks/useUiFeatures.ts` | Прапорці фіч (toast, bulk, columns...) |
| `useTableColumns` | `hooks/useTableColumns.ts` | Видимість колонок → localStorage |
| `useBulkSelect` | `hooks/useBulkSelect.ts` | Вибір рядків для групових дій |
| `useSavedFilters` | `hooks/useSavedFilters.ts` | Збереження пресетів фільтрів |
| `useDirtyForm` | `hooks/useDirtyForm.ts` | Захист форми від втрати змін |
| `useConfirm` | `hooks/useConfirm.ts` | Промісний confirm-діалог |
| `useDebounce` | `hooks/useDebounce.ts` | Дебаунс пошукового рядка |
| `useRequireAuth` | `lib/auth.ts` | Захист сторінки по ролях |
| `useInlineEdit` | `hooks/useInlineEdit.ts` | Inline редагування в таблиці |
| `useKeyboardShortcut` | `hooks/useKeyboardShortcut.ts` | Глобальні гарячі клавіші |

---

## useTableColumns — управління колонками

```typescript
import { useTableColumns, type ColumnDef } from '@/hooks/useTableColumns';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';

// 1. Визнач колонки (useMemo — стабільна референція)
const COLUMNS = useMemo<ColumnDef[]>(() => [
  { key: 'name',   label: 'Назва',      defaultVisible: true },
  { key: 'status', label: 'Статус',     defaultVisible: true },
  { key: 'extra',  label: 'Додатково',  defaultVisible: false },
], []);

// 2. Підключи хук — повний набір:
// visibleColumns — видимі у USER-DEFINED порядку з кастомними label ← рендерь таблицю по ньому
// orderedColumns — всі колонки в user-defined порядку ← передавай в ColumnsDropdown
// order, customLabels — для hasCustomization
// reorder/renameColumn/resetConfig — callbacks для ColumnsDropdown
const {
  visibleKeys: colVisible,  // Set — для colSpan або додаткових перевірок
  visibleColumns,           // ← ПО ЦЬОМУ рендерь TableHead і TableCell
  orderedColumns,           // ← ЦЕ передавай в ColumnsDropdown
  order, customLabels,
  toggle: toggleCol, reorder, renameColumn, resetConfig,
} = useTableColumns('my-page', COLUMNS);

// 3. ColumnsDropdown — columns={orderedColumns} (НЕ COLUMNS!)
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
  className="ml-auto"
/>

// 4. TableHead — через map, НЕ colVisible.has()
{visibleColumns.map(col => <TableHead key={col.key}>{col.label}</TableHead>)}

// 5. TableCell — через map з if/key на кожну колонку
{visibleColumns.map(col => {
  if (col.key === 'name')   return <TableCell key="name">{item.name}</TableCell>;
  if (col.key === 'status') return <TableCell key="status">{item.status}</TableCell>;
  if (col.key === 'extra')  return <TableCell key="extra">—</TableCell>;
  return null;
})}

// 6. colSpan — visibleColumns.length (НЕ colVisible.size!)
colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)}
```

**Правила:**
- `❌ {colVisible.has('X') && <TableHead>}` — СТАРИЙ паттерн, не порушує порядок
- `✅ {visibleColumns.map(col => ...)}` — ПРАВИЛЬНИЙ паттерн, порядок з user config
- `columns={orderedColumns}` в ColumnsDropdown — НЕ `COLUMNS` (щоб label і порядок відображались)
- Чекбокс bulk-select і колонка кнопок дій — **НЕ** входять у `COLUMNS`
- `COLUMNS` у `useMemo` — обов'язково (стабільна референція)
- Ключ унікальний по сторінці; для вкладок: `'catalog-works'`, `'catalog-goods'`, `'catalog-services'`
- localStorage keys: `sto_columns_<key>` (visible), `sto_col_order_<key>`, `sto_col_labels_<key>`

---

## useBulkSelect — групові дії

```typescript
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';

const bulkSelect = useBulkSelect(data?.items ?? []);

// indeterminate через ref (DOM property — не можна через React prop)
const selectAllRef = useRef<HTMLInputElement | null>(null);
useEffect(() => {
  if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
}, [bulkSelect.someSelected]);

// Дії
const bulkActions: BulkAction[] = [{
  label: 'Видалити вибрані',
  variant: 'destructive',
  onClick: async (ids) => {
    if (!(await confirm({ title: `Видалити ${ids.length}?`, variant: 'destructive' }))) return;
    // ✅ Promise.allSettled — ніколи Promise.all для bulk
    const results = await Promise.allSettled(ids.map(id => apiFetch(`/resource/${id}`, { method: 'DELETE' })));
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed === 0) toast.success(`Видалено ${ids.length}`);
    else toast.warning(`Видалено ${ids.length - failed} з ${ids.length}. ${failed} помилок`);
    bulkSelect.clear(); load();
  },
}];

// Render
{features.bulkActionsEnabled && bulkSelect.count > 0 && (
  <BulkActionsBar count={bulkSelect.count} selectedIds={Array.from(bulkSelect.selected)}
    actions={bulkActions} onClear={bulkSelect.clear} className="mb-3" />
)}

// TableHead checkbox
{features.bulkActionsEnabled && (
  <TableHead className="w-9 pr-0">
    <input type="checkbox" checked={bulkSelect.allSelected} ref={selectAllRef}
      onChange={bulkSelect.toggleAll} className="h-3.5 w-3.5 rounded border-border" />
  </TableHead>
)}

// TableRow checkbox
{features.bulkActionsEnabled && (
  <TableCell className="w-9 pr-0">
    <input type="checkbox" checked={bulkSelect.isSelected(item.id)}
      onChange={() => bulkSelect.toggle(item.id)} className="h-3.5 w-3.5 rounded border-border" />
  </TableCell>
)}
```

---

## useSavedFilters — збережені фільтри

```typescript
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { SavedFiltersBar } from '@/components/ui/saved-filters-bar';

// Тип фільтрів extends Record<string, unknown>
interface MyFilters extends Record<string, unknown> {
  search: string; status: string; showDeleted: boolean;
}

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

// При зміні будь-якого фільтра — скинути активний пресет
setSearch(v); setPage(1); setActiveSavedFilterId(null);

// Render
{features.savedFiltersEnabled && (
  <SavedFiltersBar<MyFilters>
    saved={savedFilters} activeId={activeSavedFilterId}
    onApply={applyFilter} onSave={handleSaveFilter} onRemove={removeFilter}
    className="mb-3"
  />
)}
```

---

## useDirtyForm — захист незбережених змін

```typescript
import { useDirtyForm } from '@/hooks/useDirtyForm';

const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

// При відкритті форми
dirty.resetDirty();

// На кожну зміну поля
<Input onChange={e => { setForm(f => ({ ...f, name: e.target.value })); dirty.markDirty(); }} />

// Перед закриттям модалі (confirmClose — синхронний, повертає Promise<boolean>)
const closeModal = async () => {
  if (!(await dirty.confirmClose())) return;
  setShowModal(false);
};

// Після збереження
dirty.resetDirty();
```

---

## useConfirm — підтвердження дій

```typescript
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

const { confirm, dialogProps } = useConfirm();

// Видалення
const handleDelete = async (id: string) => {
  if (!(await confirm({ title: 'Видалити запис?', variant: 'destructive' }))) return;
  await apiFetch(`/resource/${id}`, { method: 'DELETE' });
  toast.success('Видалено');
  load();
};

// Обов'язково в кінці return JSX:
<ConfirmDialog {...dialogProps} />
```

---

## Toast-сповіщення

```typescript
import { toast } from '@/lib/toast';

// ✅ Використовуй toast напряму — НЕ перевіряй features.toastEnabled вручну
// (ToastContainer рендериться тільки коли потрібно)
toast.success('Збережено');
toast.success(`Фільтр "${name}" збережено`);
toast.success(`Видалено ${n}`);
toast.warning(`Видалено ${ok} з ${total}. ${total - ok} помилок`);  // bulk partial
toast.error(e instanceof Error ? e.message : 'Помилка');
toast.info('Синхронізацію завершено');

// ❌ Не перевіряй if (features.toastEnabled) — це зайве
// ❌ Не використовуй setError для системних помилок — тільки toast.error
// ✅ setError залишай тільки для валідаційних помилок всередині форми
```

---

## Ref-cache — довідник даних

```typescript
import { getCached, setCache } from '@/lib/ref-cache';

// Для довідників (filials, lifts, warehouses) — завжди через cache
useEffect(() => {
  const cached = getCached<Branch[]>('cache:branches');
  if (cached) setBranches(cached);
  apiFetch<Branch[]>('/branches')
    .then(data => { setCache('cache:branches', data); setBranches(data); })
    .catch(() => {});
}, []);
```

---

## Пагінація

```typescript
// Проста пагінація кнопками Попередня/Наступна
<div className="flex items-center justify-between pt-4">
  <span className="text-sm text-muted-foreground">
    {data ? `${(page - 1) * 20 + 1}–${Math.min(page * 20, data.total)} з ${data.total}` : ''}
  </span>
  <div className="flex gap-2">
    <Button variant="outline" size="sm" onClick={() => setPage(p => p - 1)} disabled={page === 1}>
      <ChevronLeft className="h-4 w-4" />Попередня
    </Button>
    <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)}
      disabled={!data || page * 20 >= data.total}>
      Наступна<ChevronRight className="h-4 w-4" />
    </Button>
  </div>
</div>
```

---

## Checklist для нової list-сторінки

- [ ] `useRequireAuth(['OWNER', 'ADMIN', ...])` — перший рядок компоненту
- [ ] `mountedRef` guard на всіх `setState` в async callback
- [ ] `let cancelled = false` + `return () => { cancelled = true }` у `useEffect` з fetch
- [ ] `useTableColumns` повна деструктуризація: `{ visibleColumns, orderedColumns, order, customLabels, toggle, reorder, renameColumn, resetConfig }`
- [ ] `ColumnsDropdown` отримує `columns={orderedColumns}` (не COLUMNS!) + `onReorder/onRename/onReset/hasCustomization`
- [ ] TableHead рендериться через `visibleColumns.map(col => <TableHead key={col.key}>{col.label}</TableHead>)`
- [ ] TableCell рендериться через `visibleColumns.map(col => { if(col.key==='X') return <TableCell key="X">...</TableCell>; return null; })`
- [ ] `colSpan = visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)` — НЕ `colVisible.size`
- [ ] `useBulkSelect` + `BulkActionsBar` + чекбокси в TableHead/TableRow
- [ ] `useSavedFilters` + `SavedFiltersBar`
- [ ] `useDirtyForm` на кожній формі (markDirty на onChange, confirmClose перед закриттям)
- [ ] `useConfirm` + `<ConfirmDialog {...dialogProps} />` для видалень
- [ ] `toast.success/error/warning` замість `alert()` або `window.confirm()`
- [ ] `Promise.allSettled` для bulk-операцій (ніколи `Promise.all`)
- [ ] Фільтри скидають `setActiveSavedFilterId(null)` при зміні
- [ ] Кнопки видалення: `className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"`
- [ ] `pnpm --filter @sto/web exec tsc --noEmit` — 0 помилок

---

## Windows Dev

```powershell
pnpm --filter @sto/web dev      # http://localhost:3001
pnpm --filter @sto/web exec tsc --noEmit  # TypeScript check
```
