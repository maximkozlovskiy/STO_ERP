'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, ShoppingCart, Search, Eye, EyeOff, Pencil, Trash2, Zap } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import {
  usePurchaseOrders,
  purchaseOrdersKeys,
  PurchaseOrder,
} from '@/hooks/api/usePurchaseOrders';
import { inventoryKeys } from '@/hooks/api/useInventory';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchCombobox } from '@/components/ui/search-combobox';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { DetailPanel, PanelField, type DetailPanelTab } from '@/components/ui/detail-panel';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import {
  PURCHASE_ORDER_PANEL_SCHEMA,
  buildPanelFields,
  schemaToPanelConfigFields,
} from '@/lib/panel-schema';
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
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDetailPanel } from '@/hooks/useDetailPanel';
import { useDetailPanelConfig } from '@/hooks/useDetailPanelConfig';
import { useTableColumns } from '@/hooks/useTableColumns';
import { useColumnDrag } from '@/hooks/useColumnDrag';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { toast } from '@/lib/toast';
import { cn, displayCounterpartyName } from '@/lib/utils';
import { fmtMoney, fmtDate } from '@/lib/format';

interface Supplier {
  id: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
}
interface Warehouse {
  id: string;
  name: string;
  isMain: boolean;
}
interface Good {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  purchasePrice: number | null;
}

interface GoodUoM {
  id: string;
  unitOfMeasureId: string;
  unitName: string;
  unitShortName: string;
  coefficient: number;
  isDefault: boolean;
}

interface PoFilters extends Record<string, unknown> {
  status: string;
  q: string;
  showDeleted: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка',
  ORDERED: 'Замовлено',
  PARTIAL: 'Частково',
  RECEIVED: 'Отримано',
  CANCELLED: 'Скасовано',
};
const STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary',
  ORDERED: 'default',
  PARTIAL: 'warning',
  RECEIVED: 'success',
  CANCELLED: 'destructive',
};
const STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ORDERED', 'CANCELLED'],
  ORDERED: ['RECEIVED', 'CANCELLED'],
  PARTIAL: ['RECEIVED', 'CANCELLED'],
  RECEIVED: [],
  CANCELLED: [],
};
const STATUS_ACTION_LABELS: Record<string, string> = {
  ORDERED: 'Підтвердити замовлення',
  RECEIVED: 'Позначити отриманим',
  CANCELLED: 'Скасувати',
  PARTIAL: 'Часткове отримання',
};

function fmt(n: number) {
  return fmtMoney(n) + ' ₴';
}

export default function PurchaseOrdersPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'STOREKEEPER']);

  const queryClient = useQueryClient();
  const { confirm, dialogProps } = useConfirm();
  const features = useUiFeatures();

  const COLUMNS = useMemo(
    () => [
      { key: 'number', label: 'Номер', defaultVisible: true },
      { key: 'supplier', label: 'Постачальник', defaultVisible: true },
      { key: 'warehouse', label: 'Склад', defaultVisible: true },
      { key: 'status', label: 'Статус', defaultVisible: true },
      { key: 'amount', label: 'Сума', defaultVisible: true },
      { key: 'date', label: 'Дата', defaultVisible: true },
    ],
    [],
  );

  const {
    visibleKeys: colVisible,
    visibleColumns,
    orderedColumns,
    order,
    customLabels,
    toggle: toggleCol,
    reorder,
    renameColumn,
    resetConfig,
  } = useTableColumns('purchase-orders', COLUMNS);
  const { dragProps } = useColumnDrag(visibleColumns, reorder, orderedColumns);

  const detailPanel = useDetailPanel('purchase-orders');
  const panelConfig = useDetailPanelConfig('purchase-orders-panel');

  // Local filter & pagination state
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q);
  const [showDeleted, setShowDeleted] = useState(false);
  const [error, setError] = useState('');

  // React Query hooks
  const limit = 20;
  const {
    data: queryData,
    isLoading: loading,
    error: queryError,
  } = usePurchaseOrders({
    page,
    limit,
    status,
    q: debouncedQ,
    showDeleted,
  });
  const orders = queryData?.items ?? [];
  const total = queryData?.total ?? 0;

  // Saved filters
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const {
    saved: savedFilters,
    save: saveFilter,
    remove: removeFilter,
  } = useSavedFilters<PoFilters>('purchase-orders');

  const applyFilter = useCallback((preset: { id: string; filters: PoFilters }) => {
    setStatus(preset.filters.status ?? '');
    setQ(preset.filters.q ?? '');
    setShowDeleted(preset.filters.showDeleted ?? false);
    setPage(1);
    setActiveSavedFilterId(preset.id);
  }, []);

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = saveFilter(name, { status, q, showDeleted });
      setActiveSavedFilterId(preset.id);
      if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
    },
    [saveFilter, status, q, showDeleted, features.toastEnabled],
  );

  // Bulk select
  const bulkSelect = useBulkSelect(orders);

  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
  }, [bulkSelect.someSelected]);

  // Unsaved guard for create/receive modals
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  // Modal & form state
  const [selectedPO, setSelectedPO] = useState<PurchaseOrder | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showDetail, setShowDetail] = useState<PurchaseOrder | null>(null);
  const [showReceive, setShowReceive] = useState<PurchaseOrder | null>(null);

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [supplierDisplayName, setSupplierDisplayName] = useState('');
  const [form, setForm] = useState({ supplierId: '', warehouseId: '', notes: '' });
  const [lines, setLines] = useState<
    {
      goodId: string;
      goodName: string;
      quantity: string;
      price: string;
      unit: string; // Bug #233: базова одиниця Good — fallback коли UoMs порожні
      unitId: string;
      unitShortName: string;
      coefficient: number;
      goodUoMs: GoodUoM[];
    }[]
  >([]);
  const [saving, setSaving] = useState(false);

  const [receiveLines, setReceiveLines] = useState<{ lineId: string; receivedQty: string }[]>([]);

  interface PricingResult {
    updated: number;
    details: {
      goodId: string;
      goodName: string;
      costPrice: number;
      oldSalePrice: number;
      newSalePrice: number;
    }[];
  }
  const [pricingResult, setPricingResult] = useState<Record<string, PricingResult>>({});
  const [applyingPricingId, setApplyingPricingId] = useState<string | null>(null);

  const bulkDeleteSelected = useCallback(
    async (ids: string[]) => {
      if (
        !(await confirm({
          title: `Видалити ${ids.length} замовлень?`,
          confirmLabel: 'Видалити',
          variant: 'destructive',
        }))
      )
        return;
      const results = await Promise.allSettled(
        ids.map(id => apiFetch(`/purchase-orders/${id}`, { method: 'DELETE' })),
      );
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.length - succeeded;
      bulkSelect.clear();
      queryClient.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
      if (features.toastEnabled) {
        if (succeeded > 0 && failed === 0) toast.success(`Видалено ${succeeded} замовлень`);
        else if (succeeded > 0)
          toast.warning(`Видалено ${succeeded} з ${results.length}. ${failed} не вдалось`);
        else toast.error('Не вдалося видалити замовлення');
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

  useEffect(() => {
    if (!showCreate) return;
    let cancelled = false;

    const apply = (wList: Warehouse[]) => {
      if (cancelled) return;
      setWarehouses(wList);
      const mainW = wList.find(x => x.isMain) ?? (wList.length === 1 ? wList[0] : null);
      // Auto-select main warehouse only if the user hasn't already picked one
      // (e.g. modal re-opened after a slow fetch — preserves manual choice).
      if (mainW) setForm(f => (f.warehouseId ? f : { ...f, warehouseId: mainW.id }));
    };

    // Reference data — paint instantly from sessionStorage, refresh in background.
    const cached = getCached<Warehouse[]>('cache:warehouses');
    if (cached) apply(cached);

    apiFetch<Warehouse[] | { items: Warehouse[] }>('/warehouses')
      .then(w => {
        const wList = Array.isArray(w) ? w : w.items;
        setCache('cache:warehouses', wList);
        apply(wList);
      })
      .catch((e: unknown) => {
        if (!cancelled && !cached)
          setError(e instanceof Error ? e.message : 'Помилка завантаження довідників');
      });

    return () => {
      cancelled = true;
    };
  }, [showCreate]);

  const handleCreate = async () => {
    const validLines = lines.filter(l => l.goodId);
    for (const l of validLines) {
      const qty = parseFloat(l.quantity);
      const price = parseFloat(l.price);
      if (!Number.isFinite(qty) || qty <= 0) {
        setError('Вкажіть коректну кількість для всіх позицій');
        return;
      }
      if (!Number.isFinite(price) || price < 0) {
        setError('Вкажіть коректну ціну для всіх позицій');
        return;
      }
    }
    setSaving(true);
    try {
      await apiFetch<PurchaseOrder>('/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: form.supplierId,
          warehouseId: form.warehouseId,
          notes: form.notes || undefined,
          // Bug #231: конвертуємо display → base unit перед submit.
          // l.quantity у обраній UoM; l.coefficient = base_units_per_uom.
          // qty_base = qty_display * coeff; price_base = price_display / coeff.
          // totalAmount інваріантний: qty_base × price_base = qty_display × price_display.
          // Backward-compat: coeff=1 (default UoM або без UoMs) → нічого не змінюється.
          lines: validLines.map(l => {
            const coeff = l.coefficient || 1;
            const displayQty = parseFloat(l.quantity);
            const displayPrice = parseFloat(l.price);
            return {
              goodId: l.goodId,
              quantity: displayQty * coeff,
              price: displayPrice / coeff,
            };
          }),
        }),
      });
      setShowCreate(false);
      setForm({ supplierId: '', warehouseId: '', notes: '' });
      setSupplierDisplayName('');
      setLines([]);
      dirty.resetDirty();
      queryClient.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSaving(false);
    }
  };

  const handleTransition = async (po: PurchaseOrder, newStatus: string) => {
    if (
      !(await confirm({
        title: `Перевести замовлення ${po.number} → ${STATUS_LABELS[newStatus]}?`,
      }))
    )
      return;
    setSaving(true);
    setError('');
    try {
      await apiFetch<PurchaseOrder>(`/purchase-orders/${po.id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status: newStatus }),
      });
      setShowDetail(null);
      queryClient.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка переходу статусу');
    } finally {
      setSaving(false);
    }
  };

  const markDeleted = async (po: PurchaseOrder) => {
    if (
      !(await confirm({
        title: `Позначити замовлення ${po.number} на видалення?`,
        variant: 'destructive',
      }))
    )
      return;
    try {
      await apiFetch(`/purchase-orders/${po.id}`, { method: 'DELETE' });
      if (selectedPO?.id === po.id) setSelectedPO(null);
      queryClient.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
      toast.success('Замовлення позначено на видалення');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Помилка видалення');
    }
  };

  const loadDetail = async (po: PurchaseOrder, mode: 'detail' | 'receive') => {
    // Lines are not included in list response — fetch full PO on demand
    if (po.lines.length > 0 || po.linesCount === 0) {
      mode === 'detail' ? setShowDetail(po) : openReceiveWithLines(po);
      return;
    }
    setDetailLoading(true);
    try {
      const full = await apiFetch<PurchaseOrder>(`/purchase-orders/${po.id}`);
      mode === 'detail' ? setShowDetail(full) : openReceiveWithLines(full);
    } catch {
      /* show partial data */ mode === 'detail' ? setShowDetail(po) : openReceiveWithLines(po);
    } finally {
      setDetailLoading(false);
    }
  };

  const openReceiveWithLines = (po: PurchaseOrder) => {
    setReceiveLines(po.lines.map(l => ({ lineId: l.id!, receivedQty: '' })));
    setShowReceive(po);
  };

  const openReceive = (po: PurchaseOrder) => {
    void loadDetail(po, 'receive');
  };

  const applyPricing = async (po: PurchaseOrder) => {
    setApplyingPricingId(po.id);
    setError('');
    try {
      const result = await apiFetch<PricingResult>(`/purchase-orders/${po.id}/apply-pricing`, {
        method: 'POST',
      });
      setPricingResult(prev => ({ ...prev, [po.id]: result }));
      // Bug #211: apply-pricing змінює Good.salePrice → StockItem.salePrice у findStockItems →
      // inventory cache треба інвалідувати, інакше grid показує старі ціни до 30s staleTime
      if (result.updated > 0) {
        queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
      }
      if (features.toastEnabled) toast.success(`Розцінено ${result.updated} товарів`);
    } catch (e: unknown) {
      // Bug #199: помилка має бути видимою навіть з toastEnabled=false. Toast — додаток, не заміна setError.
      const msg = e instanceof Error ? e.message : 'Помилка розцінки';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setApplyingPricingId(null);
    }
  };

  const handleReceive = async () => {
    if (!showReceive) return;
    const receivedLines = receiveLines
      .filter(l => parseFloat(l.receivedQty) > 0)
      .map(l => ({ lineId: l.lineId, receivedQty: parseFloat(l.receivedQty) }));
    if (!receivedLines.length) {
      setError('Вкажіть кількість для хоча б однієї позиції');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await apiFetch<PurchaseOrder>(`/purchase-orders/${showReceive.id}/receive`, {
        method: 'POST',
        body: JSON.stringify({ lines: receivedLines }),
      });
      setShowReceive(null);
      dirty.resetDirty();
      queryClient.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
      // Bug #210: RECEIPT створює stock movement → stockItem.quantity змінюється,
      // тому inventory cache теж треба інвалідувати, інакше /inventory показує старі залишки
      queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка прийому товару');
    } finally {
      setSaving(false);
    }
  };

  const addLine = () => {
    setLines(l => [
      ...l,
      {
        goodId: '',
        goodName: '',
        quantity: '1',
        price: '',
        unit: '',
        unitId: '',
        unitShortName: '',
        coefficient: 1,
        goodUoMs: [],
      },
    ]);
    dirty.markDirty();
  };
  const updateLine = (i: number, field: string, value: string) => {
    setLines(l => l.map((x, idx) => (idx === i ? { ...x, [field]: value } : x)));
    dirty.markDirty();
  };
  const removeLine = (i: number) => {
    setLines(l => l.filter((_, idx) => idx !== i));
    dirty.markDirty();
  };

  const statuses = ['', 'DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED'];

  const buildPOTabs = (po: PurchaseOrder): DetailPanelTab[] => [
    {
      key: 'info',
      label: 'Основне',
      content: (
        <div className="space-y-3">
          {buildPanelFields(po, PURCHASE_ORDER_PANEL_SCHEMA, panelConfig.config, {
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
          {(po.status === 'RECEIVED' || po.status === 'PARTIAL') && (
            <div className="pt-1 space-y-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-full"
                loading={applyingPricingId === po.id}
                onClick={() => void applyPricing(po)}
              >
                Розцінити товари
              </Button>
              {pricingResult[po.id] && (
                <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-2">
                  <p className="text-[12px] text-muted-foreground">
                    Оновлено:{' '}
                    <span className="font-medium text-foreground">
                      {pricingResult[po.id].updated}
                    </span>{' '}
                    товарів
                  </p>
                  {pricingResult[po.id].details.length > 0 && (
                    <div className="space-y-1.5">
                      {pricingResult[po.id].details.map(d => (
                        <div key={d.goodId} className="text-[12px]">
                          <p className="font-medium text-foreground truncate">{d.goodName}</p>
                          <p className="text-muted-foreground">
                            {fmtMoney(d.costPrice)} ₴ →{' '}
                            <span className="line-through">{fmtMoney(d.oldSalePrice)}</span>{' '}
                            <span className="text-success-text font-medium">
                              {fmtMoney(d.newSalePrice)} ₴
                            </span>
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'lines',
      label: 'Позиції',
      content:
        !po.lines || po.lines.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Немає позицій</p>
        ) : (
          <div className="space-y-2">
            {po.lines.map((line, i) => (
              <div
                key={line.id ?? i}
                className="rounded-lg border border-border px-3 py-2 text-[13px]"
              >
                <p className="font-medium text-foreground">{line.goodName ?? line.goodId}</p>
                {line.goodSku && (
                  <p className="text-muted-foreground text-[12px]">{line.goodSku}</p>
                )}
                <p className="text-muted-foreground text-[12px] mt-0.5">
                  {line.quantity} {line.unitShortName ?? line.unit ?? ''} × {fmtMoney(line.price)} ₴
                </p>
              </div>
            ))}
          </div>
        ),
    },
  ];

  return (
    <div className="page-container">
      {(error || queryError) && (
        <div className="mb-4 text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error || (queryError instanceof Error ? queryError.message : '')}
        </div>
      )}
      <div className="page-header">
        <div>
          <h1 className="page-title">Замовлення постачальникам</h1>
          <p className="page-subtitle">{total} замовлень</p>
        </div>
      </div>

      {/* Saved filters */}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<PoFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          className="mb-3"
          hideSaveButton
        />
      )}

      {/* Status filters */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {statuses.map(s => (
          <button
            key={s}
            onClick={() => {
              setStatus(s);
              setPage(1);
              setActiveSavedFilterId(null);
            }}
            className={cn(
              'px-3 py-1 rounded-full text-sm font-medium border transition-colors',
              status === s
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground bg-surface hover:bg-secondary',
            )}
          >
            {s ? STATUS_LABELS[s] : 'Всі'}
          </button>
        ))}
      </div>

      {/* Filters row */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Input
          value={q}
          onChange={e => {
            setQ(e.target.value);
            setPage(1);
            setActiveSavedFilterId(null);
          }}
          placeholder="Пошук за номером, постачальником..."
          leftElement={<Search />}
          className="w-64"
        />

        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="outline"
            size="icon-sm"
            title={showDeleted ? 'Сховати видалені' : 'Показати видалені'}
            onClick={() => {
              setShowDeleted(v => !v);
              setPage(1);
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
            Замовлення
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
          className="mb-3"
        />
      )}

      {/* Table + DetailPanel */}
      <div className="flex">
        <div className="flex-1 min-w-0 overflow-auto bg-surface border border-border rounded-xl">
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
                {visibleColumns.map(col =>
                  col.key === 'amount' ? (
                    <TableHead key={col.key} className="text-right" {...dragProps(col.key)}>
                      {col.label}
                    </TableHead>
                  ) : (
                    <TableHead key={col.key} {...dragProps(col.key)}>
                      {col.label}
                    </TableHead>
                  ),
                )}
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
              {!loading && orders.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)}
                    className="p-0"
                  >
                    <EmptyState icon={ShoppingCart} title="Замовлень не знайдено" />
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                orders.map(po => (
                  <TableRow
                    key={po.id}
                    className={cn(
                      'group transition-colors',
                      detailPanel.enabled && 'cursor-pointer',
                      selectedPO?.id === po.id && detailPanel.enabled && 'bg-secondary',
                      bulkSelect.isSelected(po.id) && 'bg-primary/5',
                      po.deletedAt && 'opacity-60',
                    )}
                    onClick={() => {
                      if (detailPanel.enabled)
                        setSelectedPO(prev => (prev?.id === po.id ? null : po));
                    }}
                  >
                    {features.bulkActionsEnabled && (
                      <TableCell className="w-9 pr-0" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={bulkSelect.isSelected(po.id)}
                          onChange={() => bulkSelect.toggle(po.id)}
                          className="h-3.5 w-3.5 rounded border-border"
                          aria-label={`Вибрати замовлення ${po.number}`}
                        />
                      </TableCell>
                    )}
                    {visibleColumns.map(col => {
                      if (col.key === 'number')
                        return (
                          <TableCell key="number" className="font-medium text-[13px]">
                            {po.number}
                            {po.deletedAt && (
                              <Badge variant="destructive" className="ml-2 text-[10px] px-1 py-0">
                                видалено
                              </Badge>
                            )}
                          </TableCell>
                        );
                      if (col.key === 'supplier')
                        return (
                          <TableCell key="supplier" className="text-[13px]">
                            {po.supplierName ?? '—'}
                          </TableCell>
                        );
                      if (col.key === 'warehouse')
                        return (
                          <TableCell key="warehouse" className="text-[13px] text-muted-foreground">
                            {po.warehouseName ?? '—'}
                          </TableCell>
                        );
                      if (col.key === 'status')
                        return (
                          <TableCell key="status">
                            <Badge variant={STATUS_BADGE[po.status] ?? 'secondary'}>
                              {STATUS_LABELS[po.status]}
                            </Badge>
                          </TableCell>
                        );
                      if (col.key === 'amount')
                        return (
                          <TableCell key="amount" className="text-right font-semibold text-[13px]">
                            {fmtMoney(po.totalAmount)} ₴
                          </TableCell>
                        );
                      if (col.key === 'date')
                        return (
                          <TableCell key="date" className="text-[13px] text-muted-foreground">
                            {fmtDate(po.createdAt)}
                          </TableCell>
                        );
                      return null;
                    })}
                    <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        {(po.status === 'RECEIVED' || po.status === 'PARTIAL') && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            loading={applyingPricingId === po.id}
                            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            onClick={() => void applyPricing(po)}
                            title="Розцінити товари за правилами"
                          >
                            <Zap className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          title="Відкрити деталі"
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => void loadDetail(po, 'detail')}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        {!po.deletedAt && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Позначити на видалення"
                            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                            onClick={() => void markDeleted(po)}
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
          open={!!selectedPO && detailPanel.enabled}
          onClose={() => setSelectedPO(null)}
          title={selectedPO?.number ?? ''}
          subtitle={selectedPO?.supplierName}
          tabs={selectedPO ? buildPOTabs(selectedPO) : undefined}
          configFields={schemaToPanelConfigFields(PURCHASE_ORDER_PANEL_SCHEMA, panelConfig.config)}
          onToggleField={panelConfig.toggleField}
          onReorderFields={panelConfig.reorderFields}
          onReset={panelConfig.reset}
        />
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="flex justify-center gap-1.5 mt-4">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 1}
            onClick={() => setPage(p => p - 1)}
          >
            ← Назад
          </Button>
          <span className="h-8 w-8 flex items-center justify-center text-sm text-muted-foreground">
            {page}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page * limit >= total}
            onClick={() => setPage(p => p + 1)}
          >
            Вперед →
          </Button>
        </div>
      )}

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={async () => {
          if (!(await dirty.confirmClose())) return;
          setShowCreate(false);
          setForm({ supplierId: '', warehouseId: '', notes: '' });
          setSupplierDisplayName('');
          setLines([]);
          dirty.resetDirty();
        }}
        title="Нове замовлення постачальнику"
        size="xl"
        footer={
          <Button
            onClick={handleCreate}
            loading={saving}
            disabled={!form.supplierId || !form.warehouseId}
            className="w-full"
          >
            Створити замовлення
          </Button>
        }
      >
        <div className="space-y-4">
          <SearchCombobox<Supplier>
            label="Постачальник"
            required
            placeholder="Назва компанії, телефон..."
            value={form.supplierId}
            displayValue={supplierDisplayName}
            onSelect={s => {
              // Bug #139: helper повертає '(без імені)' fallback замість порожнього рядка.
              setSupplierDisplayName(displayCounterpartyName(s));
              setForm(f => ({ ...f, supplierId: s.id }));
              dirty.markDirty();
            }}
            onClear={() => {
              setSupplierDisplayName('');
              setForm(f => ({ ...f, supplierId: '' }));
            }}
            fetchItems={q =>
              apiFetch<{ items: Supplier[] }>(
                `/counterparties?type=SUPPLIER&q=${encodeURIComponent(q)}&limit=10`,
              ).then(r =>
                r.items.map(s => ({
                  ...s,
                  primary: displayCounterpartyName(s),
                })),
              )
            }
          />
          <Select
            label="Склад"
            required
            value={form.warehouseId}
            onChange={e => {
              setForm(f => ({ ...f, warehouseId: e.target.value }));
              dirty.markDirty();
            }}
            placeholder="Оберіть склад"
          >
            {warehouses.map(w => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
          <Input
            label="Примітки"
            value={form.notes}
            onChange={e => {
              setForm(f => ({ ...f, notes: e.target.value }));
              dirty.markDirty();
            }}
            placeholder="Необов'язково"
          />

          {/* Lines */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-foreground">Позиції</span>
              <Button variant="ghost" size="sm" onClick={addLine}>
                + Додати
              </Button>
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <div className="flex-1">
                    <SearchCombobox<Good>
                      placeholder="Товар..."
                      value={l.goodId}
                      displayValue={l.goodName}
                      onSelect={async g => {
                        const selectedGoodId = g.id;
                        setLines(ls =>
                          ls.map((x, idx) =>
                            idx === i
                              ? {
                                  ...x,
                                  goodId: g.id,
                                  goodName: g.name,
                                  unit: g.unit, // Bug #233: fallback одиниця коли UoMs порожні
                                  price: g.purchasePrice ? String(g.purchasePrice) : x.price,
                                  unitId: '',
                                  unitShortName: '',
                                  coefficient: 1,
                                  goodUoMs: [],
                                }
                              : x,
                          ),
                        );
                        // Завантажити UoM для цього товару
                        try {
                          const uoms = await apiFetch<GoodUoM[]>(`/goods/${g.id}/uoms`);
                          // Bug #235: race-guard за goodId-only (без stale index).
                          // Видалення/reorder рядків зсуває index → закаптурений `i` стає невірним.
                          // Шукаємо по goodId і goodUoMs.length === 0 (запобігає повторному apply).
                          setLines(ls =>
                            ls.map(x => {
                              if (x.goodId !== selectedGoodId || x.goodUoMs.length > 0) return x;
                              const defaultUom = uoms.find(u => u.isDefault) ?? uoms[0];
                              return {
                                ...x,
                                goodUoMs: uoms,
                                ...(defaultUom
                                  ? {
                                      unitId: defaultUom.id,
                                      unitShortName: defaultUom.unitShortName,
                                      coefficient: defaultUom.coefficient || 1,
                                    }
                                  : {}),
                              };
                            }),
                          );
                        } catch (err) {
                          if (features.toastEnabled) {
                            toast.error('Не вдалося завантажити одиниці виміру');
                          } else {
                            setError(
                              err instanceof Error
                                ? err.message
                                : 'Не вдалося завантажити одиниці виміру',
                            );
                          }
                        }
                      }}
                      onClear={() =>
                        setLines(ls =>
                          ls.map((x, idx) =>
                            idx === i
                              ? {
                                  ...x,
                                  goodId: '',
                                  goodName: '',
                                  unit: '',
                                  unitId: '',
                                  unitShortName: '',
                                  coefficient: 1,
                                  goodUoMs: [],
                                }
                              : x,
                          ),
                        )
                      }
                      fetchItems={q =>
                        apiFetch<{ items: Good[] }>(
                          `/goods?q=${encodeURIComponent(q)}&limit=10`,
                        ).then(r =>
                          r.items.map(g => ({
                            ...g,
                            primary: g.name,
                            secondary: g.sku ?? undefined,
                          })),
                        )
                      }
                    />
                  </div>
                  <Input
                    type="number"
                    value={l.quantity}
                    onChange={e => updateLine(i, 'quantity', e.target.value)}
                    placeholder="Кіл."
                    min="0.001"
                    step="0.001"
                    className="w-20 text-xs"
                  />
                  {l.goodUoMs.length > 0 ? (
                    <Select
                      value={l.unitId}
                      onChange={e => {
                        const selectedUom = l.goodUoMs.find(u => u.id === e.target.value);
                        if (selectedUom) {
                          const oldCoeff = l.coefficient || 1;
                          const newCoeff = selectedUom.coefficient || 1;
                          // Bug #234: не клобер user intent коли qty порожнє/NaN/≤0.
                          // Тільки оновлюємо UoM-метадані, qty лишаємо для користувача.
                          const rawQty = parseFloat(l.quantity);
                          const hasValidQty = Number.isFinite(rawQty) && rawQty > 0;
                          const newQty = hasValidQty
                            ? ((rawQty * oldCoeff) / newCoeff).toFixed(3)
                            : null;
                          setLines(ls =>
                            ls.map((x, idx) =>
                              idx === i
                                ? {
                                    ...x,
                                    unitId: selectedUom.id,
                                    unitShortName: selectedUom.unitShortName,
                                    coefficient: newCoeff,
                                    ...(newQty !== null ? { quantity: newQty } : {}),
                                  }
                                : x,
                            ),
                          );
                          dirty.markDirty();
                        }
                      }}
                      className="w-20 text-xs"
                    >
                      {l.goodUoMs.map(u => (
                        <option key={u.id} value={u.id}>
                          {u.unitShortName}
                        </option>
                      ))}
                    </Select>
                  ) : l.unit ? (
                    /* Bug #233: коли UoMs порожні — показати unit як text fallback */
                    <span className="w-20 text-xs text-muted-foreground self-center px-2 truncate">
                      {l.unit}
                    </span>
                  ) : null}
                  <Input
                    type="number"
                    value={l.price}
                    onChange={e => updateLine(i, 'price', e.target.value)}
                    placeholder="Ціна"
                    min="0"
                    step="0.01"
                    className="w-24 text-xs"
                  />
                  <button
                    onClick={() => removeLine(i)}
                    className="text-destructive/60 hover:text-destructive text-sm px-1"
                  >
                    ×
                  </button>
                </div>
              ))}
              {lines.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Замовлення можна створити без позицій і додати їх пізніше
                </p>
              )}
            </div>
          </div>
        </div>
      </Modal>

      {/* Detail modal */}
      <Modal
        open={!!showDetail}
        onClose={() => setShowDetail(null)}
        title={showDetail ? `Замовлення ${showDetail.number}` : ''}
        size="lg"
        footer={
          showDetail && STATUS_TRANSITIONS[showDetail.status]?.length > 0 ? (
            <div className="flex flex-wrap gap-2 w-full">
              {STATUS_TRANSITIONS[showDetail.status]?.map(s => (
                <Button
                  key={s}
                  variant={s === 'CANCELLED' ? 'destructive' : 'default'}
                  size="sm"
                  onClick={() =>
                    s === 'RECEIVED' && ['ORDERED', 'PARTIAL'].includes(showDetail.status)
                      ? openReceive(showDetail)
                      : handleTransition(showDetail, s)
                  }
                  loading={saving}
                >
                  {STATUS_ACTION_LABELS[s] ?? STATUS_LABELS[s]}
                </Button>
              ))}
            </div>
          ) : undefined
        }
      >
        {showDetail && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Badge variant={STATUS_BADGE[showDetail.status] ?? 'secondary'}>
                {STATUS_LABELS[showDetail.status]}
              </Badge>
              <span className="text-muted-foreground text-sm">{showDetail.supplierName}</span>
              <span className="text-foreground-faint text-sm">→ {showDetail.warehouseName}</span>
            </div>

            {/* Lines table */}
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-secondary">
                  <tr>
                    <th className="text-left px-3 py-2 text-muted-foreground">Товар</th>
                    <th className="text-right px-3 py-2 text-muted-foreground">Замовлено</th>
                    <th className="text-right px-3 py-2 text-muted-foreground">Отримано</th>
                    <th className="text-right px-3 py-2 text-muted-foreground">Ціна</th>
                    <th className="text-right px-3 py-2 text-muted-foreground">Сума</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {showDetail.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2 text-foreground">{l.goodName}</td>
                      <td className="px-3 py-2 text-right">
                        {l.quantity} {l.unitShortName ?? l.unit}
                      </td>
                      <td
                        className={cn(
                          'px-3 py-2 text-right font-medium',
                          (l.receivedQty ?? 0) >= l.quantity ? 'text-success' : 'text-warning',
                        )}
                      >
                        {l.receivedQty ?? 0}
                      </td>
                      <td className="px-3 py-2 text-right">{fmt(l.price)}</td>
                      <td className="px-3 py-2 text-right font-medium">
                        {fmt(l.amount ?? l.quantity * l.price)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-secondary">
                  <tr>
                    <td
                      colSpan={4}
                      className="px-3 py-2 text-right font-medium text-foreground-muted"
                    >
                      Разом:
                    </td>
                    <td className="px-3 py-2 text-right font-bold text-foreground">
                      {fmt(showDetail.totalAmount)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {showDetail.notes && (
              <p className="text-sm text-muted-foreground italic">{showDetail.notes}</p>
            )}
          </div>
        )}
      </Modal>

      {/* Receive modal */}
      <Modal
        open={!!showReceive}
        onClose={async () => {
          if (!(await dirty.confirmClose())) return;
          setShowReceive(null);
          dirty.resetDirty();
        }}
        title={showReceive ? `Прийом по замовленню ${showReceive.number}` : ''}
        size="lg"
        footer={
          <Button onClick={handleReceive} loading={saving} className="w-full">
            Підтвердити прийом
          </Button>
        }
      >
        {showReceive && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Вкажіть кількість, яку фактично отримано по кожній позиції
            </p>
            <div className="space-y-3">
              {showReceive.lines.map((line, i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-secondary rounded-lg">
                  <div className="flex-1">
                    <div className="text-sm font-medium text-foreground">{line.goodName}</div>
                    <div className="text-xs text-muted-foreground">
                      Замовлено: {line.quantity} {line.unitShortName ?? line.unit} · Отримано
                      раніше: {line.receivedQty ?? 0}
                    </div>
                  </div>
                  <Input
                    type="number"
                    value={receiveLines[i]?.receivedQty ?? ''}
                    onChange={e => {
                      setReceiveLines(ls =>
                        ls.map((l, idx) => (idx === i ? { ...l, receivedQty: e.target.value } : l)),
                      );
                      dirty.markDirty();
                    }}
                    placeholder={`макс. ${line.quantity - (line.receivedQty ?? 0)}`}
                    min="0"
                    max={line.quantity - (line.receivedQty ?? 0)}
                    step="0.001"
                    className="w-28 text-right"
                  />
                  <span className="text-xs text-muted-foreground">
                    {line.unitShortName ?? line.unit}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>
      <DirtyConfirmDialog {...dirty.dialogProps} />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
