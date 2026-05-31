'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { Plus, Pencil, Search, Trash2, Package, Layers, Star, Barcode, X } from 'lucide-react';
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
import { DetailPanel } from '@/components/ui/detail-panel';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import { useDetailPanel } from '@/hooks/useDetailPanel';
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
  TableCell,
} from '@/components/ui/table';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useTableColumns } from '@/hooks/useTableColumns';
import { useColumnDrag } from '@/hooks/useColumnDrag';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { toast } from '@/lib/toast';
import { ModalTabs } from '@/components/ui/modal-tabs';
import { fmtMoney, fmtDate } from '@/lib/format';

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
  barcode: string | null;
  brandId: string | null;
  notes: string | null;
  goodType?: string | null;
  preferredSupplierId?: string | null;
  preferredSupplierName?: string | null;
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
interface StockBatchDto {
  id: string;
  goodId: string;
  warehouseId: string;
  batchNumber: string | null;
  expiryDate: string | null;
  receivedQty: number;
  remainingQty: number;
  costPrice: number;
  salePrice: number;
  isActive: boolean;
  createdAt: string;
  purchaseOrderNumber: string | null;
  purchaseOrderLineId: string | null;
  unitOfMeasureId: string | null;
  unitShortName: string | null;
}

type GoodDetailTab = 'info' | 'barcodes' | 'batches';

interface GoodsFilters extends Record<string, unknown> {
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

// ─── Goods Tab ────────────────────────────────────────────────────────────────

export default function GoodsTab() {
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
  const [form, setForm] = useState({
    sku: '',
    name: '',
    unit: 'шт',
    unitId: '',
    purchasePrice: '',
    salePrice: '',
    category: '',
    brandId: '',
    barcode: '',
    notes: '',
    goodType: '',
    preferredSupplierId: '',
  });
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
  const [editGoodForm, setEditGoodForm] = useState({
    sku: '',
    name: '',
    unit: 'шт',
    unitId: '',
    purchasePrice: '',
    salePrice: '',
    category: '',
    brandId: '',
    notes: '',
    goodType: '',
    preferredSupplierId: '',
  });
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

  // ── Edit modal: UoM tab ───────────────────────────────────────────────────────
  interface GoodUoM {
    id: string;
    unitOfMeasureId: string;
    unitName: string;
    unitShortName: string;
    coefficient: number;
    isDefault: boolean;
  }
  const [modalUoMs, setModalUoMs] = useState<GoodUoM[]>([]);
  const [modalUoMsLoading, setModalUoMsLoading] = useState(false);
  const [uomError, setUomError] = useState('');
  const [showAddUoM, setShowAddUoM] = useState(false);
  const [addUoMForm, setAddUoMForm] = useState({ unitOfMeasureId: '' });
  const [addingUoM, setAddingUoM] = useState(false);
  const [deletingUoMId, setDeletingUoMId] = useState<string | null>(null);
  const modalUoMReqRef = useRef(0);
  const uomRefDefault = useRef(0);

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
  const bulkSelect = useBulkSelect(goods?.items ?? []);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
  }, [bulkSelect.someSelected]);

  const goodsLoadRef = useRef<(() => void) | null>(null);

  const goodsActions = useMemo<BulkAction[]>(
    () => [
      {
        id: 'delete',
        label: 'Видалити вибрані',
        variant: 'destructive',
        onClick: async ids => {
          if (!window.confirm(`Видалити ${ids.length} ${ids.length === 1 ? 'товар' : 'товарів'}?`))
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
    [bulkSelect, features.toastEnabled],
  );

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
      apiFetch<{ items: Brand[]; total: number }>('/brands?limit=200').catch(() => ({
        items: [],
        total: 0,
      })),
      apiFetch<Unit[]>('/units').catch(() => [] as Unit[]),
      apiFetch<{ items: Supplier[] }>('/counterparties?types=SUPPLIER,BOTH&limit=200').catch(
        () => ({ items: [] as Supplier[] }),
      ),
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
    apiFetch<PaginatedGoods>(`/goods?${p}`)
      .then(setGoods)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження'))
      .finally(() => setLoading(false));
  }, [page, debouncedQ]);

  // Keep ref in sync so goodsActions can call load() without depending on it
  useEffect(() => {
    goodsLoadRef.current = load;
  }, [load]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    const salePrice = Number(form.salePrice);
    if (!Number.isFinite(salePrice) || salePrice < 0) {
      setError("Ціна продажу повинна бути невід'ємним числом");
      return;
    }
    if (form.purchasePrice) {
      const pp = Number(form.purchasePrice);
      if (!Number.isFinite(pp) || pp < 0) {
        setError("Ціна закупівлі повинна бути невід'ємним числом");
        return;
      }
    }
    setSaving(true);
    setError('');
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
      setForm({
        sku: '',
        name: '',
        unit: 'шт',
        unitId: '',
        purchasePrice: '',
        salePrice: '',
        category: '',
        brandId: '',
        barcode: '',
        notes: '',
        goodType: '',
        preferredSupplierId: '',
      });
      goodsFormDirty.resetDirty();
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSaving(false);
    }
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
    setSaving(true);
    setError('');
    try {
      await apiFetch<void>(`/goods/${id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      if (selectedGood?.id === id) setSelectedGood(null);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка видалення');
    } finally {
      setSaving(false);
    }
  };

  const selectGood = (g: Good | null) => {
    setSelectedGood(g);
    setGoodDetailTab('info');
    if (g) loadBarcodes(g.id);
  };

  const openEditGood = (g: Good) => {
    setEditGood(g);
    setEditGoodForm({
      sku: g.sku ?? '',
      name: g.name,
      unit: g.unit,
      unitId: g.unitId ?? '',
      purchasePrice: g.purchasePrice != null ? String(g.purchasePrice) : '',
      salePrice: String(g.salePrice),
      category: g.category ?? '',
      brandId: g.brandId ?? '',
      notes: g.notes ?? '',
      goodType: g.goodType ?? '',
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
      .then(data => {
        if (modalBarcodeReqRef.current === bReqId) setModalBarcodes(data);
      })
      .catch(err => {
        if (modalBarcodeReqRef.current === bReqId)
          setBarcodeError(err instanceof Error ? err.message : 'Помилка завантаження штрихкодів');
      })
      .finally(() => {
        if (modalBarcodeReqRef.current === bReqId) setModalBarcodesLoading(false);
      });

    setModalBatchesLoading(true);
    apiFetch<{ items: StockBatchDto[]; total: number }>(`/goods/${g.id}/batches`)
      .then(data => {
        if (modalBatchReqRef.current === btReqId) setModalBatches(data.items);
      })
      .catch(err => {
        if (modalBatchReqRef.current === btReqId)
          setBatchError(err instanceof Error ? err.message : 'Помилка завантаження партій');
      })
      .finally(() => {
        if (modalBatchReqRef.current === btReqId) setModalBatchesLoading(false);
      });

    // Reset UoM tab state
    setModalUoMs([]);
    setUomError('');
    setShowAddUoM(false);
    setAddUoMForm({ unitOfMeasureId: '' });

    // Race-guarded fetch for UoMs
    const uomReqId = ++modalUoMReqRef.current;
    setModalUoMsLoading(true);
    apiFetch<GoodUoM[]>(`/goods/${g.id}/uoms`)
      .then(data => {
        if (modalUoMReqRef.current === uomReqId) setModalUoMs(data);
      })
      .catch(err => {
        if (modalUoMReqRef.current === uomReqId)
          setUomError(err instanceof Error ? err.message : 'Помилка завантаження одиниць виміру');
      })
      .finally(() => {
        if (modalUoMReqRef.current === uomReqId) setModalUoMsLoading(false);
      });
  };

  // Bug #226: refetch UoM list from server so we observe backend side-effects
  // (auto-promotion of next default after removeUoM; isDefault flag on
  // first-add). Race-guarded by modalUoMReqRef shared with openEditGood.
  const refreshUoMs = useCallback((goodId: string) => {
    const reqId = ++modalUoMReqRef.current;
    apiFetch<GoodUoM[]>(`/goods/${goodId}/uoms`)
      .then(data => {
        if (modalUoMReqRef.current === reqId) setModalUoMs(data);
      })
      .catch(() => {
        // silent — toast already shown by caller for the mutation itself
      });
  }, []);

  const addUoM = async (goodId: string) => {
    if (!addUoMForm.unitOfMeasureId) return;
    setAddingUoM(true);
    try {
      const created = await apiFetch<GoodUoM>(`/goods/${goodId}/uoms`, {
        method: 'POST',
        body: JSON.stringify({ unitOfMeasureId: addUoMForm.unitOfMeasureId }),
      });
      setModalUoMs(prev => [...prev, created]);
      setAddUoMForm({ unitOfMeasureId: '' });
      setShowAddUoM(false);
      // Bug #227: if this was the first UoM (server sets isDefault=true and
      // updates Good.unit/unitId), refresh the parent goods table to avoid
      // stale unit display.
      if (created.isDefault) load();
      if (features.toastEnabled) toast.success('Одиницю виміру додано');
    } catch (e: unknown) {
      if (features.toastEnabled) {
        toast.error(e instanceof Error ? e.message : 'Помилка додавання одиниці');
      }
    } finally {
      setAddingUoM(false);
    }
  };

  const setDefaultUoM = async (goodId: string, uomId: string) => {
    const reqId = ++uomRefDefault.current;
    try {
      await apiFetch<GoodUoM>(`/goods/${goodId}/uoms/${uomId}/default`, {
        method: 'PATCH',
      });
      if (uomRefDefault.current === reqId) {
        setModalUoMs(prev =>
          prev.map(u => ({
            ...u,
            isDefault: u.id === uomId,
          })),
        );
        // Bug #227: setDefault always updates Good.unit/unitId → refresh parent table.
        load();
        if (features.toastEnabled) toast.success('Основну одиницю змінено');
      }
    } catch (e: unknown) {
      if (uomRefDefault.current === reqId) {
        if (features.toastEnabled) {
          toast.error(e instanceof Error ? e.message : 'Помилка встановлення основної одиниці');
        }
      }
    }
  };

  const deleteUoM = async (goodId: string, uomId: string) => {
    if (!(await confirm({ title: 'Видалити одиницю виміру?', variant: 'destructive' }))) return;
    // Capture whether the deleted UoM was default BEFORE optimistic filter — used
    // to decide if we need to refresh parent goods list (Bug #227).
    const wasDefault = modalUoMs.find(u => u.id === uomId)?.isDefault === true;
    setDeletingUoMId(uomId);
    try {
      await apiFetch<void>(`/goods/${goodId}/uoms/${uomId}`, { method: 'DELETE' });
      // Bug #226: backend may auto-promote the next UoM to default; refetch
      // instead of relying on the local `filter()` (which would leave UI with
      // no default star while DB has a new one).
      refreshUoMs(goodId);
      if (wasDefault) load();
      if (features.toastEnabled) toast.success('Одиницю видалено');
    } catch (e: unknown) {
      if (features.toastEnabled) {
        toast.error(e instanceof Error ? e.message : 'Помилка видалення');
      }
    } finally {
      setDeletingUoMId(null);
    }
  };

  const saveEditGood = async () => {
    if (!editGood) return;
    const salePrice = Number(editGoodForm.salePrice);
    if (!Number.isFinite(salePrice) || salePrice < 0) {
      setEditGoodError("Ціна продажу повинна бути невід'ємним числом");
      return;
    }
    setEditGoodSaving(true);
    setEditGoodError('');
    try {
      await apiFetch<Good>(`/goods/${editGood.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          sku: editGoodForm.sku || undefined,
          name: editGoodForm.name,
          unit: editGoodForm.unit || 'шт',
          unitId: editGoodForm.unitId || undefined,
          purchasePrice: editGoodForm.purchasePrice
            ? Number(editGoodForm.purchasePrice)
            : undefined,
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
    } catch (e: unknown) {
      setEditGoodError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setEditGoodSaving(false);
    }
  };

  const totalPages = goods ? Math.ceil(goods.total / goods.limit) : 1;

  return (
    <div>
      {!modal && error && (
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
            placeholder="Пошук за назвою, артикулом, штрихкодом..."
            className="pl-9"
          />
        </div>
        <XlsxImportButton
          templateType="goods"
          importUrl="/xlsx/import/goods"
          onImportComplete={load}
        />
        <div className="flex items-center gap-2 ml-auto">
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
        </div>
        <Button
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => {
            goodsFormDirty.resetDirty();
            setError('');
            setModal(true);
          }}
        >
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
                {goodsVisibleColumns.map(col => (
                  <TableHead key={col.key} {...goodsDragProps(col.key)}>
                    {col.label}
                  </TableHead>
                ))}
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
                goods?.items.map(g => (
                  <TableRow
                    key={g.id}
                    className={`cursor-pointer ${selectedGood?.id === g.id ? 'bg-secondary' : ''}`}
                    onClick={() => {
                      if (detailPanel.enabled) selectGood(selectedGood?.id === g.id ? null : g);
                    }}
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
                            <p className="font-medium">{g.name}</p>
                            {g.sku && <p className="text-muted-foreground text-[12px]">{g.sku}</p>}
                          </TableCell>
                        );
                      if (col.key === 'category')
                        return (
                          <TableCell key="category" className="text-[13px] text-muted-foreground">
                            {g.category ?? '—'}
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
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={e => {
                            e.stopPropagation();
                            openEditGood(g);
                          }}
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
                          className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                          title="Помітити на видалення"
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

        <DetailPanel
          open={!!selectedGood && detailPanel.enabled}
          onClose={() => selectGood(null)}
          title={selectedGood?.name ?? ''}
        >
          {selectedGood && (
            <div className="space-y-3 text-sm">
              {/* Detail tabs */}
              <div className="flex gap-1 bg-secondary rounded-lg p-0.5 mb-3">
                {(
                  [
                    { key: 'info' as const, label: 'Інформація', icon: Package },
                    { key: 'barcodes' as const, label: 'Штрихкоди', icon: Barcode },
                    { key: 'batches' as const, label: 'Партії', icon: Layers },
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
                        {fmtMoney(selectedGood.purchasePrice)} ₴
                      </span>
                    </div>
                  )}
                  <div>
                    <span className="text-muted-foreground">Ціна продажу:</span>{' '}
                    <span className="text-foreground font-semibold">
                      {fmtMoney(selectedGood.salePrice)} ₴
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
                    />
                    <Select
                      value={newBarcodeType}
                      onChange={e => setNewBarcodeType(e.target.value)}
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
            <Button variant="outline" onClick={() => setConfirmDeleteId(null)} className="flex-1">
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
          Товар буде позначено як видалений (soft delete). Він зникне зі списків, але залишиться в
          базі даних для архіву.
        </p>
      </Modal>

      <Modal
        open={!!editGood}
        onClose={async () => {
          if (!(await editGoodDirty.confirmClose())) return;
          setEditGood(null);
        }}
        title="Редагування товару"
        footer={
          <>
            <Button
              onClick={saveEditGood}
              loading={editGoodSaving}
              disabled={!editGoodForm.name || !editGoodForm.salePrice}
            >
              Зберегти
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                if (!(await editGoodDirty.confirmClose())) return;
                setEditGood(null);
              }}
            >
              Скасувати
            </Button>
          </>
        }
      >
        {editGoodError && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
            {editGoodError}
          </div>
        )}
        <div className="space-y-4">
          <Input
            label="Назва"
            required
            value={editGoodForm.name}
            onChange={e => {
              setEditGoodForm(f => ({ ...f, name: e.target.value }));
              editGoodDirty.markDirty();
            }}
            placeholder="Масло моторне 5W-40"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Артикул (SKU)"
              value={editGoodForm.sku}
              onChange={e => {
                setEditGoodForm(f => ({ ...f, sku: e.target.value }));
                editGoodDirty.markDirty();
              }}
              placeholder="OIL-5W40"
            />
            {units.length > 0 ? (
              <Select
                label="Одиниця виміру"
                value={editGoodForm.unitId}
                onChange={e => {
                  const unit = units.find(u => u.id === e.target.value);
                  setEditGoodForm(f => ({
                    ...f,
                    unitId: e.target.value,
                    unit: unit?.shortName ?? f.unit,
                  }));
                  editGoodDirty.markDirty();
                }}
              >
                <option value="">— вписати вручну</option>
                {units.map(u => (
                  <option key={u.id} value={u.id}>
                    {u.shortName} ({u.name})
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                label="Одиниця"
                value={editGoodForm.unit}
                onChange={e => {
                  setEditGoodForm(f => ({ ...f, unit: e.target.value }));
                  editGoodDirty.markDirty();
                }}
                placeholder="шт"
              />
            )}
          </div>
          {units.length > 0 && !editGoodForm.unitId && (
            <Input
              label="Одиниця (вручну)"
              value={editGoodForm.unit}
              onChange={e => setEditGoodForm(f => ({ ...f, unit: e.target.value }))}
              placeholder="шт"
            />
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Ціна закупки, ₴"
              type="number"
              value={editGoodForm.purchasePrice}
              onChange={e => {
                setEditGoodForm(f => ({ ...f, purchasePrice: e.target.value }));
                editGoodDirty.markDirty();
              }}
              placeholder="350"
            />
            <Input
              label="Ціна продажу, ₴"
              required
              type="number"
              value={editGoodForm.salePrice}
              onChange={e => {
                setEditGoodForm(f => ({ ...f, salePrice: e.target.value }));
                editGoodDirty.markDirty();
              }}
              placeholder="500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Бренд"
              value={editGoodForm.brandId}
              onChange={e => {
                setEditGoodForm(f => ({ ...f, brandId: e.target.value }));
                editGoodDirty.markDirty();
              }}
            >
              <option value="">—</option>
              {brands.map(b => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
            <Input
              label="Категорія"
              value={editGoodForm.category}
              onChange={e => {
                setEditGoodForm(f => ({ ...f, category: e.target.value }));
                editGoodDirty.markDirty();
              }}
              placeholder="Мастила"
            />
          </div>
          <Select
            label="Тип товару"
            value={editGoodForm.goodType}
            onChange={e => {
              setEditGoodForm(f => ({ ...f, goodType: e.target.value }));
              editGoodDirty.markDirty();
            }}
          >
            <option value="">Не вказано</option>
            <option value="SPARE_PART">Запчастина</option>
            <option value="CONSUMABLE">Витратний матеріал</option>
            <option value="MATERIAL">Матеріал</option>
            <option value="TOOL">Інструмент</option>
          </Select>
          <Select
            label="Основний постачальник"
            value={editGoodForm.preferredSupplierId}
            onChange={e => {
              setEditGoodForm(f => ({ ...f, preferredSupplierId: e.target.value }));
              editGoodDirty.markDirty();
            }}
          >
            <option value="">— Не вказано —</option>
            {suppliers.map(s => (
              <option key={s.id} value={s.id}>
                {s.companyName ?? [s.lastName, s.firstName].filter(Boolean).join(' ')}
              </option>
            ))}
          </Select>
          <Input
            label="Нотатки"
            value={editGoodForm.notes}
            onChange={e => {
              setEditGoodForm(f => ({ ...f, notes: e.target.value }));
              editGoodDirty.markDirty();
            }}
          />
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
                    <div className="py-6 text-center text-sm text-muted-foreground">
                      Завантаження...
                    </div>
                  )}
                  {!modalBarcodesLoading && barcodeError && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
                      {barcodeError}
                    </div>
                  )}
                  {!modalBarcodesLoading && !barcodeError && (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] text-muted-foreground">
                          {modalBarcodes.length} штрихкодів
                        </span>
                        {!showAddBarcode && (
                          <Button
                            size="sm"
                            variant="outline"
                            leftIcon={<Plus className="h-3.5 w-3.5" />}
                            onClick={() => setShowAddBarcode(true)}
                          >
                            Додати
                          </Button>
                        )}
                      </div>
                      {showAddBarcode && (
                        <AnimatedBody className="rounded-lg border border-border bg-secondary/40 p-3 space-y-3">
                          <div className="grid grid-cols-2 gap-2">
                            <Input
                              label="Штрихкод"
                              required
                              value={addBarcodeForm.barcode}
                              onChange={e =>
                                setAddBarcodeForm(f => ({ ...f, barcode: e.target.value }))
                              }
                              placeholder="4820123456789"
                            />
                            <Select
                              label="Тип"
                              value={addBarcodeForm.type}
                              onChange={e =>
                                setAddBarcodeForm(f => ({ ...f, type: e.target.value }))
                              }
                            >
                              <option value="EAN13">EAN-13</option>
                              <option value="EAN8">EAN-8</option>
                              <option value="CODE128">Code 128</option>
                              <option value="CODE39">Code 39</option>
                              <option value="QR">QR</option>
                            </Select>
                          </div>
                          <div className="flex gap-2 justify-end">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setShowAddBarcode(false);
                                setAddBarcodeForm({ barcode: '', type: 'EAN13' });
                              }}
                            >
                              Скасувати
                            </Button>
                            <Button
                              size="sm"
                              loading={addingBarcode2}
                              disabled={!addBarcodeForm.barcode}
                              onClick={async () => {
                                if (!editGood) return;
                                setAddingBarcode2(true);
                                try {
                                  const created = await apiFetch<GoodBarcode>(
                                    `/goods/${editGood.id}/barcodes`,
                                    {
                                      method: 'POST',
                                      body: JSON.stringify({
                                        barcode: addBarcodeForm.barcode,
                                        type: addBarcodeForm.type,
                                      }),
                                    },
                                  );
                                  setModalBarcodes(prev => [...prev, created]);
                                  setAddBarcodeForm({ barcode: '', type: 'EAN13' });
                                  setShowAddBarcode(false);
                                  toast.success('Штрихкод додано');
                                } catch (e: unknown) {
                                  toast.error(e instanceof Error ? e.message : 'Помилка');
                                } finally {
                                  setAddingBarcode2(false);
                                }
                              }}
                            >
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
                                <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                                  Штрихкод
                                </th>
                                <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                                  Тип
                                </th>
                                <th
                                  className="w-10 px-3 py-2 text-muted-foreground"
                                  title="Основний"
                                >
                                  <Star className="h-3.5 w-3.5" />
                                </th>
                                <th className="w-12" />
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                              {modalBarcodes.map(bc => (
                                <tr
                                  key={bc.id}
                                  className="bg-surface hover:bg-secondary/50 transition-colors"
                                >
                                  <td className="px-3 py-2 font-mono text-foreground">
                                    {bc.barcode}
                                  </td>
                                  <td className="px-3 py-2 text-muted-foreground">{bc.type}</td>
                                  <td className="px-3 py-2 text-center">
                                    {bc.isPrimary && (
                                      <Star className="h-3.5 w-3.5 text-warning-text fill-warning-text" />
                                    )}
                                  </td>
                                  <td className="px-3 py-2 text-center">
                                    <button
                                      type="button"
                                      disabled={deletingBarcodeId2 === bc.id}
                                      onClick={async () => {
                                        if (!editGood) return;
                                        setDeletingBarcodeId2(bc.id);
                                        try {
                                          await apiFetch(
                                            `/goods/${editGood.id}/barcodes/${bc.id}`,
                                            { method: 'DELETE' },
                                          );
                                          setModalBarcodes(prev =>
                                            prev.filter(b => b.id !== bc.id),
                                          );
                                          toast.success('Штрихкод видалено');
                                        } catch (e: unknown) {
                                          toast.error(e instanceof Error ? e.message : 'Помилка');
                                        } finally {
                                          setDeletingBarcodeId2(null);
                                        }
                                      }}
                                      className="text-destructive/70 hover:text-destructive hover:bg-destructive/10 p-1 rounded transition-colors"
                                      title="Видалити"
                                    >
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
                        <p className="text-[13px] text-muted-foreground text-center py-4">
                          Штрихкодів немає
                        </p>
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
                    <div className="py-6 text-center text-sm text-muted-foreground">
                      Завантаження...
                    </div>
                  )}
                  {!modalBatchesLoading && batchError && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
                      {batchError}
                    </div>
                  )}
                  {!modalBatchesLoading && !batchError && modalBatches.length === 0 && (
                    <p className="text-[13px] text-muted-foreground text-center py-4">
                      Партій немає
                    </p>
                  )}
                  {!modalBatchesLoading && !batchError && modalBatches.length > 0 && (
                    <div className="rounded-xl border border-border overflow-hidden">
                      <table className="w-full text-[13px]">
                        <thead className="bg-secondary border-b border-border">
                          <tr>
                            <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                              Партія / Накладна
                            </th>
                            <th className="text-right px-3 py-2 text-muted-foreground font-medium">
                              Отримано
                            </th>
                            <th className="text-right px-3 py-2 text-muted-foreground font-medium">
                              Залишок
                            </th>
                            <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                              Одиниця
                            </th>
                            <th className="text-right px-3 py-2 text-muted-foreground font-medium">
                              Собів., ₴
                            </th>
                            <th className="text-right px-3 py-2 text-muted-foreground font-medium">
                              Продаж, ₴
                            </th>
                            <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                              Дата
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {modalBatches.map(b => (
                            <tr
                              key={b.id}
                              className="bg-surface hover:bg-secondary/50 transition-colors"
                            >
                              <td className="px-3 py-2 text-foreground">
                                {b.batchNumber ?? b.purchaseOrderNumber ?? '—'}
                              </td>
                              <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                                {b.receivedQty}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {b.remainingQty > 0 ? (
                                  <span className="text-foreground">{b.remainingQty}</span>
                                ) : (
                                  <span className="text-muted-foreground line-through">
                                    {b.remainingQty}
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-muted-foreground text-[12px]">
                                {b.unitShortName ?? '—'}
                              </td>
                              <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                                {fmtMoney(b.costPrice)}
                              </td>
                              <td className="px-3 py-2 text-right text-foreground tabular-nums">
                                {fmtMoney(b.salePrice)}
                              </td>
                              <td className="px-3 py-2 text-muted-foreground">
                                {fmtDate(b.createdAt)}
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
            {
              key: 'uoms',
              label: 'Одиниці виміру',
              icon: <Package className="h-3.5 w-3.5" />,
              count: modalUoMs.length,
              content: (
                <div className="space-y-3">
                  {modalUoMsLoading && (
                    <div className="py-6 text-center text-sm text-muted-foreground">
                      Завантаження...
                    </div>
                  )}
                  {!modalUoMsLoading && uomError && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
                      {uomError}
                    </div>
                  )}
                  {!modalUoMsLoading && !uomError && (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] text-muted-foreground">
                          {modalUoMs.length} одиниці
                        </span>
                        {!showAddUoM && (
                          <Button
                            size="sm"
                            variant="outline"
                            leftIcon={<Plus className="h-3.5 w-3.5" />}
                            onClick={() => setShowAddUoM(true)}
                          >
                            Додати
                          </Button>
                        )}
                      </div>
                      {showAddUoM && (
                        <AnimatedBody className="rounded-lg border border-border bg-secondary/40 p-3 space-y-3">
                          <Select
                            label="Одиниця виміру"
                            required
                            value={addUoMForm.unitOfMeasureId}
                            onChange={e =>
                              setAddUoMForm(f => ({ ...f, unitOfMeasureId: e.target.value }))
                            }
                          >
                            <option value="">— Виберіть одиницю —</option>
                            {units.map(u => (
                              <option key={u.id} value={u.id}>
                                {u.shortName} ({u.name})
                              </option>
                            ))}
                          </Select>
                          <div className="flex gap-2 justify-end">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setShowAddUoM(false);
                                setAddUoMForm({ unitOfMeasureId: '' });
                              }}
                            >
                              Скасувати
                            </Button>
                            <Button
                              size="sm"
                              loading={addingUoM}
                              disabled={!addUoMForm.unitOfMeasureId}
                              onClick={() => editGood && addUoM(editGood.id)}
                            >
                              Додати
                            </Button>
                          </div>
                        </AnimatedBody>
                      )}
                      {modalUoMs.length > 0 && (
                        <div className="rounded-xl border border-border overflow-hidden">
                          <table className="w-full text-[13px]">
                            <thead className="bg-secondary border-b border-border">
                              <tr>
                                <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                                  Одиниця
                                </th>
                                <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                                  Коефіцієнт
                                </th>
                                <th
                                  className="w-10 px-3 py-2 text-muted-foreground"
                                  title="Основна"
                                >
                                  <Star className="h-3.5 w-3.5" />
                                </th>
                                <th className="w-12" />
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                              {modalUoMs.map(u => (
                                <tr
                                  key={u.id}
                                  className="bg-surface hover:bg-secondary/50 transition-colors"
                                >
                                  <td className="px-3 py-2 text-foreground">
                                    <div>
                                      <p className="font-medium">{u.unitShortName}</p>
                                      <p className="text-[12px] text-muted-foreground">
                                        {u.unitName}
                                      </p>
                                    </div>
                                  </td>
                                  <td className="px-3 py-2 text-muted-foreground">
                                    {u.coefficient}
                                  </td>
                                  <td className="px-3 py-2 text-center">
                                    {u.isDefault ? (
                                      <Star className="h-3.5 w-3.5 text-warning-text fill-warning-text mx-auto" />
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => editGood && setDefaultUoM(editGood.id, u.id)}
                                        className="text-muted-foreground hover:text-warning-text transition-colors"
                                        title="Встановити основною"
                                      >
                                        <Star className="h-3.5 w-3.5" />
                                      </button>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 text-center">
                                    <button
                                      type="button"
                                      disabled={deletingUoMId === u.id}
                                      onClick={() => editGood && deleteUoM(editGood.id, u.id)}
                                      className="text-destructive/70 hover:text-destructive hover:bg-destructive/10 p-1 rounded transition-colors"
                                      title="Видалити"
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {modalUoMs.length === 0 && !showAddUoM && (
                        <p className="text-[13px] text-muted-foreground text-center py-4">
                          Додаткових одиниць не додано
                        </p>
                      )}
                    </>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Modal>

      <Modal
        open={modal}
        onClose={async () => {
          if (!(await goodsFormDirty.confirmClose())) return;
          setModal(false);
        }}
        title="Новий товар / запчастина"
        size="xl"
        footer={
          <Button
            onClick={create}
            loading={saving}
            disabled={!form.name || !form.salePrice}
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
          <Input
            label="Назва"
            required
            value={form.name}
            onChange={e => {
              setForm(f => ({ ...f, name: e.target.value }));
              goodsFormDirty.markDirty();
            }}
            placeholder="Масло моторне 5W-40"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Артикул (SKU)"
              value={form.sku}
              onChange={e => {
                setForm(f => ({ ...f, sku: e.target.value }));
                goodsFormDirty.markDirty();
              }}
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
                {units.map(u => (
                  <option key={u.id} value={u.id}>
                    {u.shortName} ({u.name})
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                label="Одиниця"
                value={form.unit}
                onChange={e => {
                  setForm(f => ({ ...f, unit: e.target.value }));
                  goodsFormDirty.markDirty();
                }}
                placeholder="шт"
              />
            )}
          </div>
          {units.length > 0 && !form.unitId && (
            <Input
              label="Одиниця (вручну)"
              value={form.unit}
              onChange={e => {
                setForm(f => ({ ...f, unit: e.target.value }));
                goodsFormDirty.markDirty();
              }}
              placeholder="шт"
            />
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Ціна закупки, ₴"
              type="number"
              value={form.purchasePrice}
              onChange={e => {
                setForm(f => ({ ...f, purchasePrice: e.target.value }));
                goodsFormDirty.markDirty();
              }}
              placeholder="350"
            />
            <Input
              label="Ціна продажу, ₴"
              required
              type="number"
              value={form.salePrice}
              onChange={e => {
                setForm(f => ({ ...f, salePrice: e.target.value }));
                goodsFormDirty.markDirty();
              }}
              placeholder="500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Бренд"
              value={form.brandId}
              onChange={e => {
                setForm(f => ({ ...f, brandId: e.target.value }));
                goodsFormDirty.markDirty();
              }}
            >
              <option value="">—</option>
              {brands.map(b => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
            <Input
              label="Категорія"
              value={form.category}
              onChange={e => {
                setForm(f => ({ ...f, category: e.target.value }));
                goodsFormDirty.markDirty();
              }}
              placeholder="Мастила"
            />
          </div>
          <Select
            label="Тип товару"
            value={form.goodType}
            onChange={e => {
              setForm(f => ({ ...f, goodType: e.target.value }));
              goodsFormDirty.markDirty();
            }}
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
            onChange={e => {
              setForm(f => ({ ...f, preferredSupplierId: e.target.value }));
              goodsFormDirty.markDirty();
            }}
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
            onChange={e => {
              setForm(f => ({ ...f, barcode: e.target.value }));
              goodsFormDirty.markDirty();
            }}
            placeholder="4820000000000"
          />
          <Input
            label="Нотатки"
            value={form.notes}
            onChange={e => {
              setForm(f => ({ ...f, notes: e.target.value }));
              goodsFormDirty.markDirty();
            }}
          />
        </div>
      </Modal>
      <DirtyConfirmDialog {...goodsFormDirty.dialogProps} />
      <DirtyConfirmDialog {...editGoodDirty.dialogProps} />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
