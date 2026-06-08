'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import {
  Plus,
  Pencil,
  Search,
  Trash2,
  Package,
  Star,
  Barcode,
  Eye,
  EyeOff,
  RotateCcw,
} from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { EMPTY_ITEMS } from '@/hooks/api/usePaginatedList';
import { getCached, setCache } from '@/lib/ref-cache';
import {
  CategoryTree,
  collectDescendantIds,
  type CategoryNode,
} from '@/components/ui/category-tree';
import { CategoryManagerModal } from '@/components/ui/category-manager-modal';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { DetailPanel, PanelField } from '@/components/ui/detail-panel';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import { useDetailPanel } from '@/hooks/useDetailPanel';
import { useDetailPanelConfig } from '@/hooks/useDetailPanelConfig';
import { XlsxImportButton } from '@/components/ui/xlsx-import-button';
import { BatchViewerModal } from '@/components/ui/batch-viewer-modal';
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
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
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { useBulkIndeterminate } from '@/hooks/useBulkIndeterminate';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useTableColumns } from '@/hooks/useTableColumns';
import { useColumnDrag } from '@/hooks/useColumnDrag';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { toast } from '@/lib/toast';
import { fmtMoney } from '@/lib/format';
import { GoodEditModal, type GoodForModal } from '@/components/ui/GoodEditModal';
import { GOOD_TYPE_LABELS, GOOD_TYPE_BADGE } from '@sto/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Brand {
  id: string;
  name: string;
}
interface Unit {
  id: string;
  name: string;
  shortName: string;
  isSystem: boolean;
  coefficient: number;
  width?: number | null;
  height?: number | null;
  depth?: number | null;
  volume?: number | null;
  weight?: number | null;
}
interface Good {
  id: string;
  sku: string | null;
  name: string;
  unit: string;
  unitId: string | null;
  purchasePrice: number | null;
  salePrice: number;
  category: string | null;
  goodCategoryId?: string | null;
  goodCategoryName?: string | null;
  barcode: string | null;
  brandId: string | null;
  notes: string | null;
  goodType?: string | null;
  preferredSupplierId?: string | null;
  preferredSupplierName?: string | null;
  deletedAt?: string | null;
}
interface Supplier {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}
interface PaginatedGoods {
  items: Good[];
  total: number;
  page: number;
  limit: number;
}
interface GoodBarcode {
  id: string;
  barcode: string;
  type: string;
  isPrimary: boolean;
}
type GoodDetailTab = 'info' | 'barcodes';

interface GoodsFilters extends Record<string, unknown> {
  search: string;
}

import { Pagination } from '@/components/ui/pagination';

// ─── Goods Tab ────────────────────────────────────────────────────────────────

const GOODS_PANEL_FIELDS = [
  { key: 'sku', label: 'Артикул' },
  { key: 'type', label: 'Тип' },
  { key: 'unit', label: 'Одиниця' },
  { key: 'cost_price', label: 'Ціна закупки' },
  { key: 'sale_price', label: 'Ціна продажу' },
  { key: 'category', label: 'Категорія' },
  { key: 'barcode', label: 'Штрихкод' },
  { key: 'supplier', label: 'Постачальник' },
  { key: 'notes', label: 'Нотатки' },
] as const;

export default function GoodsTab() {
  const { confirm, dialogProps } = useConfirm();
  const features = useUiFeatures();
  const detailPanel = useDetailPanel('catalog-goods');
  const panelConfig = useDetailPanelConfig('catalog-goods-panel');
  const [goods, setGoods] = useState<PaginatedGoods | null>(null);
  const { sort: goodsSort, toggle: toggleGoodsSort } = useSortState('name', 'asc');
  const [brands, setBrands] = useState<Brand[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [goodCatTree, setGoodCatTree] = useState<CategoryNode[]>([]);
  const [selectedGoodCat, setSelectedGoodCat] = useState<string | null>(null);
  const [goodCatManagerOpen, setGoodCatManagerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showDeleted, setShowDeleted] = useState(false);
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [selectedGood, setSelectedGood] = useState<Good | null>(null);
  const [goodDetailTab, setGoodDetailTab] = useState<GoodDetailTab>('info');
  const [barcodes, setBarcodes] = useState<GoodBarcode[]>([]);
  const [barcodesLoading, setBarcodesLoading] = useState(false);
  const [newBarcode, setNewBarcode] = useState('');
  const [newBarcodeType, setNewBarcodeType] = useState('EAN13');
  const [addingBarcode, setAddingBarcode] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // editGood: Good | null = редагування; goodModalOpen = відкрита створювальна модалка
  const [editGood, setEditGood] = useState<Good | null>(null);
  const [goodModalOpen, setGoodModalOpen] = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [batchViewerGoodId, setBatchViewerGoodId] = useState<string | null>(null);
  // Bug #309: in-flight set для restore — блокує дублюючі POST.
  const [restoringIds, setRestoringIds] = useState<Set<string>>(new Set());

  const GOODS_COLUMNS = useMemo(
    () => [
      { key: 'name', label: 'Назва / Артикул', defaultVisible: true },
      { key: 'category', label: 'Категорія', defaultVisible: true },
      { key: 'unit', label: 'Одиниця', defaultVisible: false },
      { key: 'purchase', label: 'Закупівля, ₴', defaultVisible: true },
      { key: 'sale', label: 'Продаж, ₴', defaultVisible: true },
    ],
    [],
  );

  const {
    visibleKeys: goodsColVisible,
    visibleColumns: goodsVisibleColumns,
    orderedColumns: goodsOrderedColumns,
    order: goodsOrder,
    customLabels: goodsCustomLabels,
    toggle: toggleGoodsCol,
    reorder: reorderGoods,
    renameColumn: renameGoodsCol,
    resetConfig: resetGoodsConfig,
  } = useTableColumns('catalog-goods', GOODS_COLUMNS);
  const { dragProps: goodsDragProps } = useColumnDrag(
    goodsVisibleColumns,
    reorderGoods,
    goodsOrderedColumns,
  );

  // ── Saved filters ────────────────────────────────────────────────────────────
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const {
    saved: savedFilters,
    save: saveFilter,
    remove: removeFilter,
  } = useSavedFilters<GoodsFilters>('catalog-goods');

  const applyFilter = useCallback((preset: { id: string; filters: GoodsFilters }) => {
    setQ(preset.filters.search ?? '');
    setPage(1);
    setActiveSavedFilterId(preset.id);
  }, []);

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = saveFilter(name, { search: q });
      setActiveSavedFilterId(preset.id);
      if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
    },
    [saveFilter, q, features.toastEnabled],
  );

  // ── Bulk select ──────────────────────────────────────────────────────────────
  // Bug #328: `?? []` creates a fresh array literal each render → useBulkSelect prunes
  // every cycle. Use module-level frozen EMPTY_ITEMS for stable reference.
  const rawGoodsItems = goods?.items ?? (EMPTY_ITEMS as unknown as Good[]);
  const goodsItems = useMemo(() => {
    if (!rawGoodsItems.length) return rawGoodsItems;
    const dir = goodsSort.sortDir === 'asc' ? 1 : -1;
    return [...rawGoodsItems].sort((a, b) => {
      if (goodsSort.sortBy === 'sale') return ((a.salePrice ?? 0) - (b.salePrice ?? 0)) * dir;
      if (goodsSort.sortBy === 'purchase')
        return ((a.purchasePrice ?? 0) - (b.purchasePrice ?? 0)) * dir;
      return (a.name ?? '').localeCompare(b.name ?? '', 'uk') * dir;
    });
  }, [rawGoodsItems, goodsSort]);
  const { selectAllRef, ...bulkSelect } = useBulkIndeterminate(goodsItems);

  const goodsLoadRef = useRef<(() => void) | null>(null);

  const goodsActions = useMemo<BulkAction[]>(
    () => [
      {
        id: 'delete',
        label: 'Видалити вибрані',
        variant: 'destructive',
        // Bug #313: useConfirm замість window.confirm.
        onClick: async ids => {
          if (
            !(await confirm({
              title: `Видалити ${ids.length} ${ids.length === 1 ? 'товар' : 'товарів'}?`,
              variant: 'destructive',
            }))
          )
            return;
          const results = await Promise.allSettled(
            ids.map(id => apiFetch(`/goods/${id}`, { method: 'DELETE' })),
          );
          const succeeded = results.filter(r => r.status === 'fulfilled').length;
          const failed = results.length - succeeded;
          bulkSelect.clear();
          goodsLoadRef.current?.();
          if (features.toastEnabled) {
            if (failed === 0)
              toast.success(`Видалено ${succeeded} ${succeeded === 1 ? 'товар' : 'товарів'}`);
            else toast.warning(`Видалено ${succeeded} з ${results.length}. ${failed} не вдалось`);
          }
        },
      },
    ],
    [bulkSelect, features.toastEnabled, confirm],
  );

  // Bug #323: race-guard для CategoryManagerModal refetch — без нього швидкі CRUD
  // (rename → add → toggle) запускали кілька fetch-ів, resolve order не гарантовано →
  // stale tree (без щойно доданої категорії).
  const goodCatReqRef = useRef(0);
  const loadGoodCategories = useCallback(() => {
    const cached = getCached<CategoryNode[]>('cache:good-categories');
    if (cached) setGoodCatTree(cached);
    const reqId = ++goodCatReqRef.current;
    apiFetch<CategoryNode[]>('/good-categories', { headers: { 'Cache-Control': 'no-cache' } })
      .then(d => {
        if (goodCatReqRef.current !== reqId) return;
        setGoodCatTree(d);
        setCache('cache:good-categories', d);
      })
      .catch((e: unknown) => {
        // Optional load — tree falls back to cached/empty; log for debug-ability.
        console.warn('[GoodsTab] /good-categories failed:', e instanceof Error ? e.message : e);
      });
  }, []);

  useEffect(() => {
    // Reference data (brands, units, suppliers) — paint instantly from
    // sessionStorage, then refresh all in parallel.
    const cBrands = getCached<Brand[]>('cache:brands');
    const cUnits = getCached<Unit[]>('cache:units');
    const cSuppliers = getCached<Supplier[]>('cache:suppliers');
    const cGoodCats = getCached<CategoryNode[]>('cache:good-categories');
    if (cBrands) setBrands(cBrands);
    if (cUnits) setUnits(cUnits);
    if (cSuppliers) setSuppliers(cSuppliers);
    if (cGoodCats) setGoodCatTree(cGoodCats);

    // Bug #315: AbortController щоб setState не виконувався після unmount
    // (React warning у DEV + memory churn).
    const ac = new AbortController();
    Promise.all([
      apiFetch<{ items: Brand[]; total: number }>('/brands?limit=200', { signal: ac.signal }).catch(
        () => ({
          items: [],
          total: 0,
        }),
      ),
      apiFetch<Unit[]>('/units', { signal: ac.signal }).catch(() => [] as Unit[]),
      apiFetch<{ items: Supplier[] }>('/counterparties?types=SUPPLIER,BOTH&limit=200', {
        signal: ac.signal,
      }).catch(() => ({ items: [] as Supplier[] })),
      apiFetch<CategoryNode[]>('/good-categories', { signal: ac.signal }).catch(
        () => [] as CategoryNode[],
      ),
    ]).then(([brandsRes, unitsRes, suppliersRes, goodCatsRes]) => {
      if (ac.signal.aborted) return;
      setBrands(brandsRes.items);
      setCache('cache:brands', brandsRes.items);
      setUnits(unitsRes);
      setCache('cache:units', unitsRes);
      setSuppliers(suppliersRes.items);
      setCache('cache:suppliers', suppliersRes.items);
      setGoodCatTree(goodCatsRes);
      setCache('cache:good-categories', goodCatsRes);
    });
    return () => ac.abort();
  }, []);

  // Bug #307: race-guard для swift showDeleted/q/page toggles — outdated response відкидається.
  const goodCategoryIds = useMemo(
    () => (selectedGoodCat ? collectDescendantIds(goodCatTree, selectedGoodCat) : undefined),
    [selectedGoodCat, goodCatTree],
  );

  const loadReqRef = useRef(0);
  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), limit: '30' });
    if (debouncedQ) p.set('q', debouncedQ);
    if (showDeleted) p.set('showDeleted', 'true');
    if (goodCategoryIds?.length) goodCategoryIds.forEach(id => p.append('goodCategoryIds', id));
    else if (selectedGoodCat) p.set('goodCategoryId', selectedGoodCat);
    const reqId = ++loadReqRef.current;
    apiFetch<PaginatedGoods>(`/goods?${p}`)
      .then(r => {
        if (loadReqRef.current !== reqId) return;
        setGoods(r);
      })
      .catch((e: unknown) => {
        if (loadReqRef.current !== reqId) return;
        setError(e instanceof Error ? e.message : 'Помилка завантаження');
      })
      .finally(() => {
        if (loadReqRef.current === reqId) setLoading(false);
      });
  }, [page, debouncedQ, showDeleted, selectedGoodCat, goodCategoryIds]);

  // Keep ref in sync so goodsActions can call load() without depending on it
  useEffect(() => {
    goodsLoadRef.current = load;
  }, [load]);

  useEffect(() => {
    load();
  }, [load]);

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
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка додавання штрихкоду');
    } finally {
      setAddingBarcode(false);
    }
  };

  const deleteBarcode = async (goodId: string, barcodeId: string) => {
    if (!(await confirm({ title: 'Видалити штрихкод?', variant: 'destructive' }))) return;
    try {
      await apiFetch<void>(`/goods/${goodId}/barcodes/${barcodeId}`, { method: 'DELETE' });
      loadBarcodes(goodId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка видалення штрихкоду');
    }
  };

  const markForDeletion = async (id: string) => {
    setDeleting(true);
    setError('');
    try {
      await apiFetch<void>(`/goods/${id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      if (selectedGood?.id === id) setSelectedGood(null);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка видалення');
    } finally {
      setDeleting(false);
    }
  };

  const restoreGood = async (id: string) => {
    // Bug #309: in-flight guard + clear stale error.
    if (restoringIds.has(id)) return;
    setError('');
    setRestoringIds(prev => new Set(prev).add(id));
    try {
      await apiFetch<Good>(`/goods/${id}/restore`, { method: 'POST' });
      load();
      if (features.toastEnabled) toast.success('Товар відновлено');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка відновлення');
    } finally {
      setRestoringIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const selectGood = useCallback(
    (g: Good | null) => {
      setSelectedGood(g);
      setGoodDetailTab('info');
      if (g) loadBarcodes(g.id);
    },
    [loadBarcodes],
  );

  const handleGoodSaved = useCallback(
    (saved: GoodForModal) => {
      const wasCreating = goodModalOpen;
      setGoodModalOpen(false);
      load();
      // Якщо створювали — одразу відкриваємо для редагування (додати штрихкоди, UoM)
      if (wasCreating) {
        setEditGood(saved as Good);
      } else {
        setEditGood(null);
      }
    },
    [goodModalOpen, load],
  );

  const totalPages = goods ? Math.ceil(goods.total / goods.limit) : 1;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
      {!goodModalOpen && !editGood && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<GoodsFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          hideSaveButton
        />
      )}

      <div className="flex items-center gap-3 flex-wrap shrink-0">
        <Input
          value={q}
          onChange={e => {
            setQ(e.target.value);
            setPage(1);
            setActiveSavedFilterId(null);
          }}
          placeholder="Пошук за назвою, артикулом, штрихкодом..."
          leftElement={<Search />}
          className="flex-1 min-w-48 h-8 text-[13px]"
        />
        <XlsxImportButton
          templateType="goods"
          importUrl="/xlsx/import/goods"
          onImportComplete={load}
        />
        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="outline"
            size="icon-sm"
            title={showDeleted ? 'Сховати видалені' : 'Показати видалені'}
            onClick={() => {
              setShowDeleted(d => !d);
              setPage(1);
              bulkSelect.clear();
            }}
            className={showDeleted ? 'border-primary text-primary' : ''}
          >
            {showDeleted ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
          {features.savedFiltersEnabled && <SaveFilterButton onSave={handleSaveFilter} />}
          <ColumnsDropdown
            columns={goodsOrderedColumns}
            visibleKeys={goodsColVisible}
            onToggle={toggleGoodsCol}
            onReorder={reorderGoods}
            onRename={renameGoodsCol}
            onReset={resetGoodsConfig}
            hasCustomization={
              JSON.stringify(goodsOrder) !== JSON.stringify(GOODS_COLUMNS.map(c => c.key)) ||
              Object.keys(goodsCustomLabels).length > 0
            }
          />
          <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
          <Button
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => {
              setError('');
              setGoodModalOpen(true);
            }}
          >
            Товар
          </Button>
        </div>
      </div>

      {features.bulkActionsEnabled && (
        <BulkActionsBar
          count={bulkSelect.count}
          selectedIds={[...bulkSelect.selected]}
          actions={goodsActions}
          onClear={bulkSelect.clear}
        />
      )}

      <div className="flex flex-1 min-h-0">
        <div className="table-scroll-container flex-1 min-h-0 min-w-0 overflow-auto border border-border rounded-xl bg-surface">
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
                {goodsVisibleColumns.map(col =>
                  ['name', 'sale', 'purchase'].includes(col.key) ? (
                    <SortableHead
                      key={col.key}
                      sortKey={col.key}
                      currentSort={goodsSort}
                      onSort={toggleGoodsSort}
                      {...goodsDragProps(col.key)}
                    >
                      {col.label}
                    </SortableHead>
                  ) : (
                    <TableHead key={col.key} {...goodsDragProps(col.key)}>
                      {col.label}
                    </TableHead>
                  ),
                )}
                <TableHead>Тип</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell
                    colSpan={goodsVisibleColumns.length + (features.bulkActionsEnabled ? 4 : 3)}
                    className="py-10 text-center"
                  >
                    <div className="flex justify-center">
                      <Spinner size="md" />
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!loading && goods?.items.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={goodsVisibleColumns.length + (features.bulkActionsEnabled ? 4 : 3)}
                    className="p-0"
                  >
                    <EmptyState icon={Package} title="Нічого не знайдено" />
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                goods?.items.map(g => {
                  const isDeleted = !!g.deletedAt;
                  return (
                    <TableRow
                      key={g.id}
                      className={`group ${detailPanel.enabled && !isDeleted ? 'cursor-pointer' : ''} ${isDeleted ? 'opacity-60 bg-secondary/30' : selectedGood?.id === g.id && detailPanel.enabled ? 'bg-secondary' : ''}`}
                      onClick={
                        detailPanel.enabled && !isDeleted
                          ? () => selectGood(selectedGood?.id === g.id ? null : g)
                          : undefined
                      }
                    >
                      {features.bulkActionsEnabled && (
                        <TableCell onClick={e => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={bulkSelect.isSelected(g.id)}
                            onChange={() => bulkSelect.toggle(g.id)}
                            className="h-4 w-4 accent-primary"
                            aria-label={`Обрати ${g.name}`}
                          />
                        </TableCell>
                      )}
                      {goodsVisibleColumns.map(col => {
                        if (col.key === 'name')
                          return (
                            <TableCell key="name">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p
                                  className={`font-medium ${isDeleted ? 'line-through text-muted-foreground' : ''}`}
                                >
                                  {g.name}
                                </p>
                                {isDeleted && <Badge variant="secondary">видалено</Badge>}
                              </div>
                              {g.sku && (
                                <p className="text-muted-foreground text-[12px]">{g.sku}</p>
                              )}
                            </TableCell>
                          );
                        if (col.key === 'category')
                          return (
                            <TableCell key="category" className="text-[13px] text-muted-foreground">
                              {g.goodCategoryName ?? g.category ?? '—'}
                            </TableCell>
                          );
                        if (col.key === 'unit')
                          return (
                            <TableCell key="unit" className="text-[13px] text-muted-foreground">
                              {g.unit}
                            </TableCell>
                          );
                        if (col.key === 'purchase')
                          return (
                            <TableCell key="purchase" className="text-[13px]">
                              {g.purchasePrice != null ? `${fmtMoney(g.purchasePrice)} ₴` : '—'}
                            </TableCell>
                          );
                        if (col.key === 'sale')
                          return (
                            <TableCell key="sale" className="font-medium text-[13px]">
                              {fmtMoney(g.salePrice)} ₴
                            </TableCell>
                          );
                        return null;
                      })}
                      <TableCell>
                        {g.goodType ? (
                          <Badge variant={GOOD_TYPE_BADGE[g.goodType] ?? 'secondary'}>
                            {GOOD_TYPE_LABELS[g.goodType] ?? g.goodType}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {isDeleted ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={restoringIds.has(g.id)}
                              disabled={restoringIds.has(g.id)}
                              onClick={e => {
                                e.stopPropagation();
                                void restoreGood(g.id);
                              }}
                              className="text-success/70 hover:text-success hover:bg-success/10"
                              title="Відновити"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          ) : (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={e => {
                                  e.stopPropagation();
                                  setEditGood(g);
                                }}
                                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={e => {
                                  e.stopPropagation();
                                  setConfirmDeleteId(g.id);
                                }}
                                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                                title="Помітити на видалення"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </div>

        <DetailPanel
          open={!!selectedGood && detailPanel.enabled}
          onClose={() => selectGood(null)}
          title={selectedGood?.name ?? ''}
          configFields={GOODS_PANEL_FIELDS.map(f => ({
            ...f,
            hidden: panelConfig.isFieldHidden(f.key),
          }))}
          onToggleField={panelConfig.toggleField}
          onReset={panelConfig.reset}
        >
          {selectedGood && (
            <div className="space-y-3 text-sm">
              {/* Detail tabs */}
              <div className="flex gap-1 bg-secondary rounded-lg p-0.5 mb-3">
                {(
                  [
                    { key: 'info' as const, label: 'Інформація', icon: Package },
                    { key: 'barcodes' as const, label: 'Штрихкоди', icon: Barcode },
                  ] as const
                ).map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    onClick={() => {
                      setGoodDetailTab(key);
                      if (key === 'barcodes') loadBarcodes(selectedGood.id);
                    }}
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
                  <PanelField
                    fieldKey="sku"
                    label="Артикул"
                    value={selectedGood.sku}
                    hidden={panelConfig.isFieldHidden('sku')}
                  />
                  <PanelField
                    fieldKey="type"
                    label="Тип"
                    hidden={panelConfig.isFieldHidden('type')}
                    value={
                      selectedGood.goodType ? (
                        <Badge variant={GOOD_TYPE_BADGE[selectedGood.goodType] ?? 'secondary'}>
                          {GOOD_TYPE_LABELS[selectedGood.goodType] ?? selectedGood.goodType}
                        </Badge>
                      ) : undefined
                    }
                  />
                  <PanelField
                    fieldKey="unit"
                    label="Одиниця"
                    value={selectedGood.unit}
                    hidden={panelConfig.isFieldHidden('unit')}
                  />
                  <PanelField
                    fieldKey="cost_price"
                    label="Ціна закупки"
                    value={
                      selectedGood.purchasePrice != null
                        ? `${fmtMoney(selectedGood.purchasePrice)} ₴`
                        : undefined
                    }
                    hidden={panelConfig.isFieldHidden('cost_price')}
                  />
                  <PanelField
                    fieldKey="sale_price"
                    label="Ціна продажу"
                    value={`${fmtMoney(selectedGood.salePrice)} ₴`}
                    hidden={panelConfig.isFieldHidden('sale_price')}
                  />
                  <PanelField
                    fieldKey="category"
                    label="Категорія"
                    value={selectedGood.goodCategoryName ?? selectedGood.category}
                    hidden={panelConfig.isFieldHidden('category')}
                  />
                  <PanelField
                    fieldKey="barcode"
                    label="Штрихкод"
                    value={selectedGood.barcode}
                    hidden={panelConfig.isFieldHidden('barcode')}
                  />
                  <PanelField
                    fieldKey="supplier"
                    label="Постачальник"
                    value={selectedGood.preferredSupplierName}
                    hidden={panelConfig.isFieldHidden('supplier')}
                  />
                  <PanelField
                    fieldKey="notes"
                    label="Нотатки"
                    value={selectedGood.notes}
                    hidden={panelConfig.isFieldHidden('notes')}
                  />
                </div>
              )}

              {/* Barcodes tab */}
              {goodDetailTab === 'barcodes' && (
                <div className="space-y-3">
                  {barcodesLoading ? (
                    <div className="flex justify-center py-4">
                      <Spinner size="sm" />
                    </div>
                  ) : (
                    <>
                      {barcodes.length === 0 && (
                        <p className="text-[12px] text-muted-foreground text-center py-3">
                          Штрихкоди відсутні
                        </p>
                      )}
                      {barcodes.map(bc => (
                        <div
                          key={bc.id}
                          className="flex items-center justify-between gap-2 bg-secondary rounded-lg px-3 py-2"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-[12px] font-mono text-foreground truncate">
                              {bc.barcode}
                            </p>
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
                    <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                      Додати штрихкод
                    </p>
                    <Input
                      placeholder="Штрихкод"
                      value={newBarcode}
                      onChange={e => setNewBarcode(e.target.value)}
                      className="h-8 text-[13px]"
                    />
                    <Select
                      value={newBarcodeType}
                      onChange={e => setNewBarcodeType(e.target.value)}
                      className="h-8 text-[13px] py-0.5 px-2 pr-7"
                    >
                      {['EAN13', 'UPC', 'QR', 'CODE128'].map(t => (
                        <option key={t} value={t}>
                          {t}
                        </option>
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

        <CategoryTree
          tree={goodCatTree}
          selectedId={selectedGoodCat}
          storageKey="sto:cat-tree:goods"
          onSelect={id => {
            setSelectedGoodCat(id);
            setPage(1);
          }}
          onManage={() => setGoodCatManagerOpen(true)}
          label="Категорії товарів"
        />
      </div>

      <CategoryManagerModal
        open={goodCatManagerOpen}
        onClose={() => setGoodCatManagerOpen(false)}
        type="good"
        tree={goodCatTree}
        onChanged={loadGoodCategories}
      />

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
            <Button variant="outline" onClick={() => setConfirmDeleteId(null)} className="flex-1">
              Скасувати
            </Button>
            <Button
              variant="destructive"
              loading={deleting}
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
          Товар буде позначено як видалений (soft delete). Він зникне зі списків, але залишиться в
          базі даних для архіву.
        </p>
      </Modal>

      <GoodEditModal
        open={goodModalOpen || !!editGood}
        good={editGood as GoodForModal | null}
        brands={brands}
        units={units}
        suppliers={suppliers}
        goodCatTree={goodCatTree}
        onClose={() => {
          setGoodModalOpen(false);
          setEditGood(null);
        }}
        onSaved={handleGoodSaved}
      />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
